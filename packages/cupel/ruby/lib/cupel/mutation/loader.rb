# frozen_string_literal: true

require 'json'
require_relative 'source'

module Cupel
  module Mutation
    module Loader
      def self.install!
        raise 'mutation requires MRI Ruby 4.0.7 and Minitest 6.0.0' unless RUBY_ENGINE == 'ruby' && RUBY_VERSION == '4.0.7' &&
          defined?(Minitest::VERSION) && Minitest::VERSION == '6.0.0'

        spec = JSON.parse(File.read(ENV.fetch('CUPEL_RUBY_MUTATION_SPEC')))
        source = Source.new(spec.fetch('root'), spec.fetch('source'), spec.fetch('hash'))
        target = source.path
        original = spec.fetch('original')
        offset = spec.fetch('offset')
        raise SourceError, 'mutation token changed' unless source.text.byteslice(offset, original.bytesize) == original

        replacement = source.text.byteslice(0, offset) + spec.fetch('replacement') +
          source.text.byteslice(offset + original.bytesize, source.text.bytesize)
        RubyVM::InstructionSequence.compile(replacement, target, target, 1)
        hook = Module.new do
          define_method(:require) do |feature|
            found = if feature == target || feature == target.delete_suffix('.rb')
                      target
                    elsif feature.is_a?(String)
                      candidates = feature.start_with?('/') ? [feature] : $LOAD_PATH.map { |dir| File.expand_path(feature, dir) }
                      candidates.find { |candidate| candidate == target || "#{candidate}.rb" == target }
                    end
            if found
              next false if $LOADED_FEATURES.include?(target)

              source.assert_fresh!
              RubyVM::InstructionSequence.compile(replacement, target, target, 1).eval
              $LOADED_FEATURES << target
              File.write(spec.fetch('seen'), 'loaded')
              true
            else
              super(feature)
            end
          end
          define_method(:require_relative) do |feature|
            origin = caller_locations(1, 1).first&.absolute_path
            raise SourceError, 'unsupported require_relative caller' unless origin && File.absolute_path(origin) == origin

            require File.expand_path(feature, File.dirname(origin))
          end
          define_method(:load) do |feature, wrap = false|
            candidate = File.expand_path(feature)
            raise SourceError, 'unsupported load or wrapped load of mutation source' if candidate == target

            super(feature, wrap)
          end
        end
        Kernel.prepend(hook)
      end
    end
  end
end

Cupel::Mutation::Loader.install!
