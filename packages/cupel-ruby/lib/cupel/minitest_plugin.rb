# frozen_string_literal: true

require 'coverage'
Coverage.start(lines: true) unless Coverage.running?
require 'json'
require 'minitest/test'

module Cupel
  module MinitestPlugin
    RECORDS = []
    SETUP = {}

    def self.warning(error)
      warn "cupel-ruby: analysis warning: #{error.class}: #{error.message}"
    end

    # Only the covered line numbers of each project file: the full per-line arrays of a large app, kept for
    # thousands of tests, exhausted memory (activeagent: about 4,100 tests killed at 16 GB).
    def self.take
      root = ENV.fetch('CUPEL_RUBY_ROOT')
      Coverage.result(stop: false, clear: true).each_with_object({}) do |(path, data), found|
        next unless path.start_with?("#{root}/")

        counts = data.is_a?(Hash) ? data[:lines] : data
        next unless counts

        covered = counts.each_index.filter_map { |i| i + 1 if counts[i].to_i.positive? }
        found[path] = { 'covered' => covered } unless covered.empty?
      end
    end

    def self.record_file_setup(file)
      SETUP[file] = take
    rescue StandardError => e
      warning(e)
    end

    def run
      begin
        before = Cupel::MinitestPlugin.take
        Cupel::MinitestPlugin::SETUP[''] = before if Cupel::MinitestPlugin::RECORDS.empty?
      rescue StandardError => e
        Cupel::MinitestPlugin.warning(e)
      end
      result = super
      begin
        record = {
          'class' => self.class.name, 'name' => name.to_s,
          'location' => self.class.instance_method(name).source_location,
          'status' => result.skipped? ? 'skipped' : result.passed? ? 'passed' : 'failed',
          'durationMs' => [(result.time * 1000).round, 0].max,
          'coverage' => {}
        }
        Cupel::MinitestPlugin::RECORDS << record
        record['coverage'] = Cupel::MinitestPlugin.take
      rescue StandardError => e
        Cupel::MinitestPlugin.warning(e)
      end
      result
    end
  end
end

Minitest::Test.prepend(Cupel::MinitestPlugin)

at_exit do
  next if Cupel::MinitestPlugin::RECORDS.empty?

  begin
    target = "#{ENV.fetch('CUPEL_RUBY_RESULT')}.#{Process.pid}.json"
    File.write(target, JSON.generate('tests' => Cupel::MinitestPlugin::RECORDS,
                                     'setup' => Cupel::MinitestPlugin::SETUP))
  rescue StandardError => e
    Cupel::MinitestPlugin.warning(e)
  end
end
