# frozen_string_literal: true

require 'json'
require 'tmpdir'
require_relative 'source'
require_relative 'sites'
require_relative 'policy'
require_relative 'assessment'

module Cupel
  module Mutation
    module Run
      def self.verify_runtime!(input)
        raise 'mutation requires MRI Ruby 4.0.7 and Minitest 6.0.0' unless RUBY_ENGINE == 'ruby' &&
          RUBY_VERSION == '4.0.7' && defined?(Minitest::VERSION) && Minitest::VERSION == '6.0.0'
        Policy.require_test_coverage!(input)
      end

      def self.candidates(root, input, wanted)
        sources = wanted.to_h do |path, _|
          [path, Source.new(root, path, input.fetch('sources').fetch(path).fetch('hash'))]
        end
        sites = sources.flat_map do |path, source|
          begin
            RubyVM::InstructionSequence.compile(source.text, source.path, source.path, 1)
          rescue SyntaxError => error
            raise SourceError, "mutation source has invalid Ruby syntax: #{path}: #{error.message}"
          end
          Sites.generate(path, source.text).select { |site| wanted[path].include?(site.line) }
        end
        [sources, sites.sort_by { |site| [site.source, site.line, site.column, site.operator] }]
      end

      def self.sample(candidates, own, cap, seed)
        target = candidates.select { |site| own.values.any? { |paths| paths.fetch(site.source, Set.new).include?(site.line) } }
        return candidates if candidates.length <= cap

        rng = Random.new(seed)
        return target + (candidates - target).shuffle(random: rng).first(cap - target.length) if target.length < cap

        groups = own.map { |id, paths| [id, target.select { |site| paths.fetch(site.source, Set.new).include?(site.line) }] }
        chosen = []
        groups.sort_by { |id, sites| [sites.length, id] }.each do |_, sites|
          extra = sites - chosen
          chosen.concat(extra) if chosen.length + extra.length <= cap
        end
        chosen.concat((target - chosen).shuffle(random: rng).first(cap - chosen.length))
      end

      def self.entry(site, outcome)
        status, killers = outcome
        row = { 'id' => site.id, 'source' => site.source, 'line' => site.line,
                'operator' => site.operator, 'status' => status }
        row['killedBy'] = killers unless killers.empty?
        row
      end

      def self.mutate(root, input, scope, config = {})
        verify_runtime!(input)
        raise 'Ruby mutation does not support function-only scope' if scope['functions']
        options = config.fetch('mutation', {})
        cap = Integer(options.fetch('maxMutants', 200))
        seconds = Integer(options.fetch('maxSeconds', 300))
        seed = Integer(options.fetch('seed', 20_261_021))
        raise 'mutation budgets must be positive' if cap < 1 || seconds < 1

        root = File.realpath(root)
        deadline = ::Process.clock_gettime(::Process::CLOCK_MONOTONIC) + seconds
        wanted, own = Policy.scope_lines(input, scope, config)
        sources, sites = candidates(root, input, wanted)
        selected = sample(sites, own, cap, seed)
        results = {}
        scratch_root = File.join(root, '.scratch')
        Dir.mkdir(scratch_root, 0o700) unless Dir.exist?(scratch_root)
        Dir.mktmpdir('cupel-rubymut-', scratch_root) do |scratch|
          assessment = Assessment.new(root, scratch, deadline)
          selected.each do |site|
            break if ::Process.clock_gettime(::Process::CLOCK_MONOTONIC) >= deadline
            result = assessment.assess(sources.fetch(site.source), site, Policy.select(input, site))
            results[site.id] = result if result
          end
        end
        sources.each_value(&:assert_fresh!)
        mutants = sites.filter_map { |site| entry(site, results[site.id]) if results[site.id] }
        complete = own.filter_map do |id, paths|
          mine = sites.select { |site| paths.fetch(site.source, Set.new).include?(site.line) }
          id if mine.all? { |site| results[site.id] && results[site.id][0] != 'error' }
        end.sort
        { 'mutants' => mutants, 'targeted' => complete, 'seed' => seed,
          'sampled' => sites.any? { |site| !results.key?(site.id) } }
      end

      def self.confirm(root, input, mutation, ids, _config = {})
        verify_runtime!(input)
        root = File.realpath(root)
        indexes = mutation.fetch('mutants').to_h { |row| [row.fetch('id'), row] }
        ids.each { |id| raise "confirm: unknown mutant #{id}" unless indexes.key?(id) }
        result = JSON.parse(JSON.generate(mutation))
        changed = result.fetch('mutants').to_h { |row| [row.fetch('id'), row] }
        scratch_root = File.join(root, '.scratch')
        Dir.mkdir(scratch_root, 0o700) unless Dir.exist?(scratch_root)
        Dir.mktmpdir('cupel-rubyconfirm-', scratch_root) do |scratch|
          cache = {}
          ids.uniq.sort.each do |id|
            row = changed.fetch(id)
            next unless row.fetch('status') == 'survived'
            path = row.fetch('source')
            source, sites = cache[path] ||= begin
              fact = Source.new(root, path, input.fetch('sources').fetch(path).fetch('hash'))
              [fact, Sites.generate(path, fact.text).to_h { |site| [site.id, site] }]
            end
            site = sites[id]
            raise "confirm: #{id} cannot be regenerated with matching metadata" unless site &&
              site.source == path && site.line == row.fetch('line') && site.operator == row.fetch('operator')
            2.times do
              outcome = Assessment.new(root, scratch, Float::INFINITY).assess(source, site, Policy.select(input, site))
              if outcome[0] != 'survived'
                row.replace(entry(site, outcome))
                break
              end
            end
          end
          cache.each_value { |source, _| source.assert_fresh! }
        end
        own = Policy.units(input, result.fetch('targeted', []))
        result['targeted'].reject! do |id|
          changed.values.any? { |row| row['status'] == 'error' && own.fetch(id).fetch(row['source'], Set.new).include?(row['line']) }
        end
        result
      end
    end
  end
end
