# frozen_string_literal: true

require 'digest'
require 'ripper'

module Cupel
  module Mutation
    Site = Struct.new(:id, :source, :line, :column, :operator, :offset, :original, :replacement, keyword_init: true) do
      def apply(text)
        text.byteslice(0, offset) + replacement + text.byteslice(offset + original.bytesize, text.bytesize)
      end
    end

    module Sites
      OPERATORS = { '==' => '!=', '!=' => '==', '>' => '<=', '<' => '>=', '>=' => '<', '<=' => '>' }.freeze

      def self.generate(source, text)
        starts = [0]
        text.each_line { |line| starts << starts.last + line.bytesize }
        Ripper.lex(text).filter_map do |(position, type, token, _state)|
          line, column = position
          replacement, operator = case type
                                  when :on_int
                                    [token.delete('_') == '0' ? '1' : '0', 'number-replace']
                                  when :on_kw
                                    [{ 'true' => 'false', 'false' => 'true' }[token], 'boolean-flip']
                                  when :on_op
                                    [OPERATORS[token], 'comparison-flip']
                                  end
          next unless replacement

          offset = starts.fetch(line - 1) + column
          signature = [source, line, column, operator, token].join(':')
          id = "ruby:#{Digest::SHA256.hexdigest(signature)[0, 16]}"
          site = Site.new(id: id, source: source, line: line, column: column, operator: operator,
                          offset: offset, original: token, replacement: replacement)
          next unless text.byteslice(offset, token.bytesize) == token
          begin
            RubyVM::InstructionSequence.compile(site.apply(text), source, source, 1)
            site
          rescue SyntaxError
            nil
          end
        end.sort_by { |site| [site.source, site.line, site.column, site.operator] }
      end
    end
  end
end
