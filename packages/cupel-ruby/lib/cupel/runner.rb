# frozen_string_literal: true

require 'json'
require 'open3'
require 'tmpdir'
require 'set'
require_relative 'lines'
require_relative 'static'

module Cupel
  module Runner
    def self.test_files(root, pattern = 'test/**/*_test.rb')
      Dir.glob(pattern, base: root).select { |file| File.file?(File.join(root, file)) }.sort
    end

    def self.failure_detail(stdout, stderr)
      lines = (stderr.empty? ? stdout : stderr).strip.lines.map(&:chomp)
      (lines.length > 40 ? lines.first(20) + ['...'] + lines.last(20) : lines).join("\n")
    end

    def self.execute(root, files, args, result_dir, select: nil)
      prefix = File.join(result_dir, 'result')
      rubyopt = [ENV['RUBYOPT'], "-r#{File.expand_path('minitest_plugin', __dir__)}"].compact.join(' ')
      env = { 'CUPEL_RUBY_RESULT' => prefix,
              'CUPEL_RUBY_ROOT' => root,
              'CUPEL_RUBY_FILES' => JSON.generate(files) }
      command = if args.first == 'rake'
                  ['ruby', '-S', *args]
                elsif args.first == 'bin/rails'
                  ['ruby', *args]
                else
                  load_path = ['-Itest', '-Ilib']
                  load_path << '-Ispec' if File.directory?(File.join(root, 'spec'))
                  ['ruby', *load_path, '-rjson', '-e', 'JSON.parse(ENV.fetch("CUPEL_RUBY_FILES")).each { |file| path = File.expand_path(file); abort "File does not exist: #{path}" unless File.file?(path); require path; Cupel::MinitestPlugin.record_file_setup(file) }']
                end
      if File.file?(File.join(root, 'Gemfile')) || ENV['BUNDLE_GEMFILE']
        # Load the plugin in the test process, after Bundler has selected the project's gems.
        env['RUBYOPT'] = nil
        command = ['bundle', 'exec', 'env', "RUBYOPT=-rbundler/setup #{rubyopt}", *command]
      else
        env['RUBYOPT'] = rubyopt
      end
      if select
        pattern = "/^#{Regexp.escape(select)}$/"
        if args.first == 'rake'
          env['TESTOPTS'] = [ENV['TESTOPTS'], "-n#{pattern}"].compact.join(' ')
        else
          command += args.first == 'bin/rails' ? ['-n', pattern] : ['--', '-n', pattern]
        end
      end
      stdout, stderr, status = Open3.capture3(env, *command, chdir: root)
      records = Dir.glob("#{prefix}.*.json").flat_map do |path|
        JSON.parse(File.read(path)).then { |data| data['tests'].empty? ? [] : [data] }
      end
      if records.empty?
        raise "Minitest did not report any tests (exit #{status.exitstatus}): #{failure_detail(stdout, stderr)}"
      end
      unless [0, 1].include?(status.exitstatus)
        raise "test command exited #{status.exitstatus}: #{failure_detail(stdout, stderr)}"
      end
      records
    end

    def self.row(raw, root)
      location = raw.fetch('location')
      raise 'test has no source location' unless location && location[0]

      file = File.expand_path(location[0]).delete_prefix("#{File.realpath(root)}/").tr(File::SEPARATOR, '/')
      raise "test outside repository: #{file}" if file.start_with?('/') || file.include?('..')

      name = "#{raw.fetch('class')} > #{raw.fetch('name')}"
      { 'id' => "#{file}::#{name}", 'file' => file, 'name' => name,
        'status' => raw.fetch('status'), 'durationsMs' => [raw.fetch('durationMs')],
        'locationLine' => location[1] }
    end

    def self.collect(root, runs, recheck, args, tests: nil)
      root = File.realpath(root)
      raise '--tests cannot be combined with a test command' if tests && %w[rake bin/rails].include?(args.first)
      files = %w[rake bin/rails].include?(args.first) ? [] : args.empty? ? test_files(root, tests || 'test/**/*_test.rb') : args
      raise "no test files match #{tests || 'test/**/*_test.rb'}" if files.empty? && args.empty?

      sources = Lines.scan(root)
      all = []
      scratch_root = File.join(root, '.scratch')
      Dir.mkdir(scratch_root) unless Dir.exist?(scratch_root)
      Dir.mktmpdir('cupel-ruby-', scratch_root) do |scratch|
        runs.times do |index|
          dir = File.join(scratch, "run#{index}")
          Dir.mkdir(dir)
          all << execute(root, files, args, dir)
        end
        first = all.first.flatten
        rows = first.flat_map { |record| record['tests'].map { |raw| row(raw, root) } }
        ids = rows.map { |r| r['id'] }
        raise 'duplicate Minitest test ids' unless ids.uniq.length == ids.length

        grouped = rows.group_by { |r| [r['file'], r['locationLine']] }
        counts = Hash.new(0)
        grouped.sort_by { |(file, line), _| [file, line] }.each do |_, group|
          next unless group.length > 1
          sample = group.first
          title = Static.definition_title(File.join(root, sample['file']), sample['locationLine'])
          key = "#{sample['file']}::#{sample['name'].split(' > ').first} > #{title}"
          counts[key] += 1
          unit = key + (counts[key] > 1 ? " ##{counts[key]}" : '')
          group.each { |r| r['unit'] = unit }
        end
        by_test = {}
        unstable = {}
        shapes = {}
        brittle = []
        rows.each_with_index do |r, i|
          raw = first.flat_map { |record| record['tests'] }[i]
          by_test[r['id']] = Lines.combine(all.map { |run|
            found = run.flatten.flat_map { |record| record['tests'] }.find { |test| row(test, root)['id'] == r['id'] }
            raise "test ids changed between runs: #{r['id']}" unless found
            Lines.covered(found['coverage'], root, sources)
          }, unstable)
          begin
            absolute = File.join(root, r['file'])
            tags, findings = Static.flags(absolute, r['locationLine'], r['id'])
            r['tags'] = tags unless tags.empty?
            r['spawnsInterpreter'] = true if Static.spawns_interpreter?(absolute, r['locationLine'])
            unit = r['unit'] || r['id']
            shapes[unit] ||= Static.shape(absolute, r['locationLine'])
            brittle.concat(findings)
          rescue StandardError => e
            warn "cupel-ruby: analysis warning: #{e.class}: #{e.message}"
          end
          r.delete('locationLine')
        end
        all.drop(1).each do |run|
          current = run.flatten.flat_map { |record| record['tests'] }.to_h do |raw|
            parsed = row(raw, root)
            [parsed['id'], parsed]
          end
          raise 'test ids changed between runs' unless current.keys.sort == ids.sort
          rows.each do |r|
            second = current.fetch(r['id'])
            r['durationsMs'] += second['durationsMs']
            r['status'] = 'failed' if second['status'] == 'failed'
            r['status'] = 'passed' if r['status'] == 'skipped' && second['status'] == 'passed'
          end
        end
        setup_runs = all.map do |run|
          setup = {}
          run.flatten.each do |record|
          test_files = record['tests'].map { |raw| row(raw, root)['file'] }.uniq
          record['setup'].each do |test_file, delta|
            relative = File.expand_path(test_file, root).delete_prefix("#{root}/").tr(File::SEPARATOR, '/')
            targets = test_file.empty? ? test_files : [relative]
            targets.each do |path|
              setup[path] ||= {}
              Lines.covered(delta, root, sources).each do |source, set|
                setup[path][source] = Lines.encode(Lines.expand(setup[path][source]) + Lines.expand(set))
              end
            end
          end
          end
          setup
        end
        setup = setup_runs.flat_map(&:keys).uniq.sort.to_h do |file|
          [file, Lines.combine(setup_runs.map { |run| run.fetch(file, {}) }, unstable)]
        end
        checked = []
        recheck.each do |unit|
          selected = rows.select { |r| (r['unit'] || r['id']) == unit }
          raise "unknown recheck unit: #{unit}" if selected.empty?
          selected.each do |r|
            dir = File.join(scratch, "recheck#{checked.length}-#{selected.index(r)}")
            Dir.mkdir(dir)
            isolated = execute(root, [r['file']], files.empty? ? args : [], dir,
                               select: r['name'].split(' > ').last)
            raw = isolated.flatten.flat_map { |record| record['tests'] }
            raise "recheck did not select exactly #{r['id']}" unless raw.length == 1 && row(raw[0], root)['id'] == r['id']
            by_test[r['id']] = Lines.covered(raw[0]['coverage'], root, sources)
          end
          checked << unit
        end
        return { 'spec' => 'cupel-spec/1', 'kind' => 'input',
                 'runtime' => { 'name' => 'ruby', 'version' => RUBY_VERSION },
                 'sources' => sources, 'tests' => rows.sort_by { |r| r['id'] },
                 'coverage' => { 'granularity' => 'test', 'byTest' => by_test,
                                 'setup' => setup, 'unstable' => unstable.sort.to_h.transform_values { |lines| Lines.encode(lines.to_a) },
                                 'rechecked' => checked.sort },
                 'shapes' => shapes, 'brittleness' => brittle }
      end
    end
  end
end
