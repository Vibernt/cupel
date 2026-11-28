# frozen_string_literal: true

require 'json'
require 'tmpdir'
require 'fileutils'
require_relative '../runner'

module Cupel
  module Mutation
    module ProcessRunner
      def self.run(root, test, scratch, seconds, spec: nil)
        file = test.fetch('file')
        name = test.fetch('name').split(' > ').last
        raise 'mutation requires a Minitest test file' unless file.start_with?('test/') && file.end_with?('_test.rb')

        dir = Dir.mktmpdir('run-', scratch)
        prefix = File.join(dir, 'result')
        seen_path = spec && JSON.parse(File.read(spec)).fetch('seen')
        rubyopt = [ENV['RUBYOPT'], "-r#{File.expand_path('../minitest_plugin', __dir__)}"].compact.join(' ')
        env = { 'CUPEL_RUBY_RESULT' => prefix, 'CUPEL_RUBY_ROOT' => root,
                'CUPEL_RUBY_FILES' => JSON.generate([file]), 'CUPEL_RUBY_MUTATION_SPEC' => spec }
        command = ['ruby', '-Itest', '-Ilib']
        command << '-Ispec' if File.directory?(File.join(root, 'spec'))
        command += ['-rjson', '-e', 'JSON.parse(ENV.fetch("CUPEL_RUBY_FILES")).each { |file| path = File.expand_path(file); abort "File does not exist: #{path}" unless File.file?(path); require path; Cupel::MinitestPlugin.record_file_setup(file) }',
                    '--', '-n', "/^#{Regexp.escape(name)}$/"]
        env, command = Runner.bundled(root, env, command, rubyopt)
        started = ::Process.clock_gettime(::Process::CLOCK_MONOTONIC)
        group = Gem.win_platform? ? { new_pgroup: true } : { pgroup: true }
        pid = ::Process.spawn(env, *command, chdir: root, out: File.join(dir, 'out'),
                              err: File.join(dir, 'err'), **group)
        status = nil
        loop do
          finished = ::Process.waitpid2(pid, ::Process::WNOHANG)
          if finished
            status = finished.last
            break
          end
          if ::Process.clock_gettime(::Process::CLOCK_MONOTONIC) - started >= seconds
            kill_tree(pid)
            ::Process.waitpid(pid)
            return { timeout: true, wall: (seconds * 1000).round, rows: [], seen: seen_path && File.exist?(seen_path) }
          end
          sleep 0.01
        end
        records = Dir.glob("#{prefix}.*.json").flat_map { |path| JSON.parse(File.read(path)).fetch('tests') }
        rows = records.select { |raw| Runner.row(raw, root)['id'] == test.fetch('id') }
        { timeout: false, code: status.exitstatus, wall: ((::Process.clock_gettime(::Process::CLOCK_MONOTONIC) - started) * 1000).round,
          rows: rows, all_rows: records, seen: seen_path && File.exist?(seen_path),
          stderr: File.read(File.join(dir, 'err'))[-1000..] }
      ensure
        FileUtils.remove_entry(dir) if dir && File.exist?(dir)
      end

      # The run and every process it started. Windows has no process groups to signal: taskkill /T stops the tree.
      def self.kill_tree(pid)
        if Gem.win_platform?
          return if system('taskkill', '/pid', pid.to_s, '/T', '/F', out: File::NULL, err: File::NULL)

          ::Process.kill('KILL', pid)
        else
          ::Process.kill('KILL', -pid)
        end
      rescue Errno::ESRCH
        nil
      end
    end
  end
end
