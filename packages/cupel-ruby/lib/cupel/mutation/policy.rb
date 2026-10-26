# frozen_string_literal: true

require 'set'
require_relative 'match'

module Cupel
  module Mutation
    module Policy
      def self.require_test_coverage!(input)
        granularity = input.fetch('coverage').fetch('granularity')
        raise "Ruby mutation requires per-test coverage; got #{granularity.inspect}" unless granularity == 'test'
      end

      def self.lines(value)
        value.to_s.split(',').flat_map do |piece|
          next [] if piece.empty?
          ends = piece.split('-').map { |part| Integer(part) }
          (ends.first..ends.last).to_a
        end.to_set
      end

      def self.units(input, ids)
        require_test_coverage!(input)
        ids.to_h do |id|
          rows = input.fetch('tests').select { |test| test.fetch('unit', test.fetch('id')) == id }
          raise "scope.targeted: unknown unit #{id}" if rows.empty?
          covered = Hash.new { |hash, key| hash[key] = Set.new }
          rows.each do |row|
            input.fetch('coverage').fetch('byTest', {}).fetch(row.fetch('id'), {}).each do |path, spec|
              covered[path].merge(lines(spec))
            end
          end
          setup = input.fetch('coverage').fetch('setup', {}).fetch(rows.first.fetch('file'), {})
          [id, covered.to_h { |path, value| [path, value - lines(setup[path])] }]
        end
      end

      def self.scope_lines(input, scope, config)
        require_test_coverage!(input)
        own = units(input, scope.fetch('targeted', []))
        requested = Hash.new { |hash, key| hash[key] = Set.new }
        input.fetch('sources').each do |path, record|
          requested[path].merge(lines(record.fetch('coverable'))) if scope['critical'] && Match.critical?(path, config)
        end
        scope.fetch('changed', {}).each do |path, range|
          raise "unknown changed source #{path}" unless input.fetch('sources').key?(path)
          requested[path].merge(range == '' || range == [] ? lines(input['sources'][path]['coverable']) : lines(range))
        end
        own.each_value { |paths| paths.each { |path, value| requested[path].merge(value) } }
        rule = config.fetch('scope', {})
        include_globs = rule.fetch('include', ['**'])
        exclude_globs = rule.fetch('exclude', [])
        wanted = requested.sort.to_h.filter_map do |path, values|
          next unless input['sources'].key?(path)
          next unless include_globs.any? { |glob| Match.glob?(glob, path) } &&
                      exclude_globs.none? { |glob| Match.glob?(glob, path) }
          current = values & lines(input['sources'][path]['coverable'])
          [path, current] unless current.empty?
        end.to_h
        [wanted, own]
      end

      def self.select(input, site)
        require_test_coverage!(input)
        coverage = input.fetch('coverage')
        input.fetch('tests').select do |test|
          next false unless test.fetch('status') == 'passed'
          own = lines(coverage.fetch('byTest', {}).fetch(test.fetch('id'), {}).fetch(site.source, ''))
          setup = lines(coverage.fetch('setup', {}).fetch(test.fetch('file'), {}).fetch(site.source, ''))
          own.include?(site.line) || setup.include?(site.line)
        end
      end
    end
  end
end
