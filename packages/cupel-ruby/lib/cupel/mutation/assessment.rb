# frozen_string_literal: true

require 'json'
require_relative 'process'

module Cupel
  module Mutation
    class Assessment
      def initialize(root, scratch, deadline)
        @root, @scratch, @deadline = root, scratch, deadline
        @baselines = {}
        @attempt = 0
      end

      def assess(source, site, selected)
        return ['no-coverage', []] if selected.empty?

        killers = []
        selected.each do |test|
          remaining = time_left
          return nil if remaining <= 0
          key = test.fetch('id')
          base = @baselines[key] ||= checked_run(source, test, [remaining, 30].min)
          return nil if base[:timeout] && time_left <= 0
          raise "unmutated Minitest selection did not complete: #{key}" unless passed?(base)

          limit = [[base[:wall] * 3.0 / 1000, 1.0].max, time_left].min
          return nil if limit <= 0
          outcome = evaluate(source, site, test, limit)
          return nil unless outcome
          return outcome if %w[error timeout].include?(outcome[0])
          killers << key if outcome[0] == 'killed'
        end
        killers.empty? ? ['survived', []] : ['killed', killers.sort]
      end

      private

      def time_left
        @deadline - ::Process.clock_gettime(::Process::CLOCK_MONOTONIC)
      end

      def checked_run(source, test, seconds, spec: nil)
        source.assert_fresh!
        ProcessRunner.run(@root, test, @scratch, seconds, spec: spec)
      ensure
        source.assert_fresh!
      end

      def passed?(result)
        !result[:timeout] && result[:code] == 0 && result[:rows]&.length == 1 &&
          result[:all_rows]&.length == 1 && result[:rows][0]['status'] == 'passed'
      end

      def complete_mutant?(result)
        !result[:timeout] && result[:seen] && [0, 1].include?(result[:code]) &&
          result[:rows]&.length == 1 && result[:all_rows]&.length == 1 &&
          %w[passed failed].include?(result[:rows][0]['status'])
      end

      # Each attempt gets a new private load receipt. A previous attempt's receipt can never prove this one loaded.
      def mutant_attempt(source, site, test, seconds)
        @attempt += 1
        spec_path = File.join(@scratch, "spec-#{@attempt}.json")
        seen_path = "#{spec_path}.seen"
        File.open(spec_path, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |file|
          file.write(JSON.generate('root' => @root, 'source' => site.source, 'hash' => source.hash,
                                   'offset' => site.offset, 'original' => site.original,
                                   'replacement' => site.replacement, 'seen' => seen_path))
        end
        checked_run(source, test, seconds, spec: spec_path)
      ensure
        File.delete(spec_path) if spec_path && File.exist?(spec_path)
        File.delete(seen_path) if seen_path && File.exist?(seen_path)
      end

      def evaluate(source, site, test, limit)
        result = mutant_attempt(source, site, test, limit)
        return handle_timeout(source, site, test, limit, result) if result[:timeout]
        return classify(result, test) if complete_mutant?(result)

        retry_limit = [limit, time_left].min
        return nil if retry_limit <= 0
        retry_result = mutant_attempt(source, site, test, retry_limit)
        return handle_timeout(source, site, test, retry_limit, retry_result) if retry_result[:timeout]
        complete_mutant?(retry_result) ? classify(retry_result, test) : ['error', []]
      end

      def handle_timeout(source, site, test, limit, result)
        return ['error', []] unless result[:seen]
        return nil if time_left <= 0

        probe = checked_run(source, test, [time_left, 30].min)
        return ['error', []] unless passed?(probe)
        return nil if time_left <= 0

        larger = 3 * [limit, 3 * probe[:wall] / 1000.0].max
        retry_result = mutant_attempt(source, site, test, [larger, time_left].min)
        return ['error', []] unless retry_result[:seen]
        if retry_result[:timeout]
          return nil if time_left <= 0
          return ['timeout', [test.fetch('id')]]
        end
        complete_mutant?(retry_result) ? classify(retry_result, test) : ['error', []]
      end

      def classify(result, test)
        result[:rows][0]['status'] == 'failed' ? ['killed', [test.fetch('id')]] : ['survived', []]
      end
    end
  end
end
