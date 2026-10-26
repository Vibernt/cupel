# frozen_string_literal: true

# SPEC section 5: same Unicode token and glob rules as the pure JS engine.
module Cupel
  module Mutation
    module Match
      DEFAULT_PATH_WORDS = %w[auth permission tenan token secret egress billing quota migrat backup delet public-api
                              credential crypto leak unsafe sign-in login security isolat sandbox privacy integrity
                              redact inject travers harden admission budget].freeze

      # Ruby's String#downcase uses the simple sigma mapping, whereas JS String#toLowerCase
      # applies Unicode's final-sigma context rule. Paths are tokenized first, as in the engine.
      def self.javascript_lower(token)
        chars = token.each_char.to_a
        chars.each_with_index.map do |char, index|
          next char.downcase unless char == 'Σ'

          before = chars[0...index].reverse.find { |part| !part.match?(/\p{Case_Ignorable}/) }
          after = chars[(index + 1)..].find { |part| !part.match?(/\p{Case_Ignorable}/) }
          before&.match?(/\p{Cased}/) && !after&.match?(/\p{Cased}/) ? 'ς' : 'σ'
        end.join
      end

      def self.tokens(text)
        out = []
        current = +''
        previous_lower = false
        text.each_char do |char|
          unless char.match?(/[\p{L}\p{Nd}]/)
            out << javascript_lower(current) unless current.empty?
            current = +''
            previous_lower = false
            next
          end
          if previous_lower && char.match?(/\p{Lu}/)
            out << javascript_lower(current)
            current = +''
          end
          current << char
          previous_lower = char.match?(/\p{Ll}/)
        end
        out << javascript_lower(current) unless current.empty?
        out
      end

      def self.word?(word, path_tokens)
        parts = tokens(word)
        return true if parts.empty?

        path_tokens.each_cons(parts.length).any? do |group|
          group[0...-1] == parts[0...-1] && group.last.start_with?(parts.last)
        end
      end

      def self.globstar?(segment)
        segment.match?(/\A\*\*+\z/)
      end

      def self.glob?(glob, path, loose: false)
        segments = glob.split('/', -1)
        segments = segments.each_with_index.reject { |segment, index| index.positive? && globstar?(segment) && globstar?(segments[index - 1]) }.map(&:first)
        expression = +''
        segments.each_with_index do |segment, index|
          if globstar?(segment)
            expression << if segments.length == 1
                            '.*'
                          elsif index.zero?
                            '(?:[^/]*/)*'
                          elsif index == segments.length - 1
                            '(?:/[^/]*)*'
                          else
                            '/(?:[^/]*/)*'
                          end
            next
          end
          expression << '/' if index.positive? && !globstar?(segments[index - 1])
          index_in_segment = 0
          while index_in_segment < segment.length
            char = segment[index_in_segment]
            if char == '*'
              last = index_in_segment
              last += 1 while last < segment.length && segment[last] == '*'
              expression << ((last - index_in_segment >= 2 && loose) ? '.*' : '[^/]*')
              index_in_segment = last
            elsif char == '?'
              expression << '[^/]'
              index_in_segment += 1
            else
              expression << Regexp.escape(char)
              index_in_segment += 1
            end
          end
        end
        Regexp.new("\\A#{expression}\\z", Regexp::MULTILINE).match?(path)
      end

      def self.critical?(path, config)
        tiers = config.fetch('tiers', {})
        return true if tiers.fetch('critical', []).any? { |glob| glob?(glob, path, loose: true) }

        words = tiers.fetch('pathWords', DEFAULT_PATH_WORDS) + tiers.fetch('extraPathWords', [])
        path_tokens = tokens(path)
        words.any? { |word| word?(word, path_tokens) }
      end
    end
  end
end
