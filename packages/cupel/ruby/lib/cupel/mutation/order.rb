# frozen_string_literal: true

module Cupel
  module Mutation
    module Order
      # Input-only order: known catchers first, then tests whose file name matches
      # the source, then the collector's original order. Runtime measurements from
      # this run must never decide which catching tests receive credit.
      def self.tests(selected, source, catchers = [])
        by_id = selected.to_h { |test| [test.fetch('id'), test] }
        matching = matching_test_files(source)
        ordered = []
        placed = {}
        place = lambda do |test|
          return unless test && !placed[test.fetch('id')]

          placed[test.fetch('id')] = true
          ordered << test
        end
        catchers.each { |id| place.call(by_id[id]) }
        selected.each { |test| place.call(test) if matching.include?(test.fetch('file')) }
        selected.each { |test| place.call(test) }
        ordered
      end

      def self.matching_test_files(source)
        stem = source.delete_suffix('.rb').delete_prefix('lib/')
        ["test/#{stem}_test.rb", "test/#{File.basename(stem)}_test.rb"].uniq
      end
    end
  end
end
