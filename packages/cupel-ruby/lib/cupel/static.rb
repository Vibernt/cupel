# frozen_string_literal: true

require 'ripper'

module Cupel
  module Static
    IGNORED = %i[on_sp on_ignored_nl on_nl on_comment].freeze

    def self.definition_title(file, line)
      tokens = Ripper.lex(File.read(file))
      declarations = tokens.each_index.select do |index|
        position, kind, value, = tokens[index]
        position[0] == line && kind == :on_ident && %w[define_method test].include?(value)
      end
      if declarations.length > 1
        raise "ambiguous test declaration at #{file}:#{line}"
      end
      raise "cannot find test declaration at #{file}:#{line}" if declarations.empty?

      method = declarations.first
      if tokens[method][2] == 'test'
        return test_declaration_title(tokens, method, file, line)
      end

      opening = ((method + 1)...tokens.length).find { |index| !IGNORED.include?(tokens[index][1]) }
      raise "define_method has no parenthesized name at #{file}:#{line}" unless tokens[opening]&.[](2) == '('
      depth = 0
      name = []
      tokens[(opening + 1)..].each do |token|
        value = token[2]
        if value == ')' && depth.zero?
          return name.join.strip
        end
        depth += 1 if value == '('
        depth -= 1 if value == ')'
        name << value
      end
      raise "unterminated define_method name at #{file}:#{line}"
    end

    def self.test_declaration_title(tokens, declaration, file, line)
      first = ((declaration + 1)...tokens.length).find { |index| !IGNORED.include?(tokens[index][1]) }
      raise "test declaration has no test name at #{file}:#{line}" unless first

      depth = 0
      block = nil
      tokens[first..].each_with_index do |token, offset|
        kind, value = token[1], token[2]
        if kind == :on_kw && value == 'do' && depth.zero?
          block = first + offset
          break
        end
        depth += 1 if %i[on_lparen on_lbracket on_lbrace on_embexpr_beg].include?(kind)
        depth -= 1 if %i[on_rparen on_rbracket on_rbrace on_embexpr_end].include?(kind)
      end
      raise "test declaration has no block at #{file}:#{line}" unless block

      title = tokens[first...block].map { |token| token[2] }.join.strip
      raise "test declaration has no test name at #{file}:#{line}" if title.empty?

      title
    end

    def self.fnv(text)
      text.b.each_byte.reduce(0x811c9dc5) { |hash, byte| ((hash ^ byte) * 0x01000193) & 0xffff_ffff }
    end

    def self.method_tokens(file, line)
      tokens = Ripper.lex(File.read(file)).drop_while { |token| token[0][0] < line }
      depth = 0
      body = []
      started = false
      tokens.each do |token|
        position, kind, value, = token
        if kind == :on_kw && %w[def do class module begin case if unless while until for].include?(value)
          # A postfix condition has no matching `end`.
          postfix = %w[if unless while until].include?(value) &&
                    body.any? { |earlier| earlier[0][0] == position[0] && !IGNORED.include?(earlier[1]) }
          unless postfix
            depth += 1
            started = true
          end
        elsif kind == :on_kw && value == 'end'
          depth -= 1 if started
          body << token
          break if started && depth.zero?
        end
        body << token unless body.last.equal?(token)
      end
      body
    end

    def self.body_tokens(file, line)
      tokens = method_tokens(file, line)
      opener = tokens.index { |token| token[1] == :on_kw && %w[def do].include?(token[2]) }
      if opener && tokens[opener][2] == 'do'
        tokens = tokens.drop(opener + 1)
      elsif opener
        boundary = tokens.each_index.find do |index|
          index > opener && %i[on_nl on_semicolon].include?(tokens[index][1])
        end
        tokens = boundary ? tokens.drop(boundary + 1) : []
      end
      tokens = tokens.take(tokens.length - 1) if tokens.last&.[](1) == :on_kw && tokens.last[2] == 'end'
      result = []
      tokens.each do |(_position, kind, value, _state)|
        next if IGNORED.include?(kind)

        masked = if %i[on_tstring_content on_tstring_beg on_tstring_end].include?(kind)
                  'S'
        elsif %i[on_int on_float on_rational on_imaginary].include?(kind)
                  'N'
        elsif %i[on_regexp_beg on_regexp_end on_regexp_content].include?(kind)
                  'R'
        else
                  value
        end
        result << masked unless %w[S R].include?(masked) && result.last == masked
      end
      result
    end

    def self.shape(file, line)
      tokens = body_tokens(file, line)
      tokens.each_cons(4).map { |part| fnv(part.join(' ')) }.uniq.sort
    end

    def self.flags(file, line, test_id)
      lines = File.readlines(file)
      previous = line > 1 ? lines[line - 2] : ''
      tags = previous.include?('# cupel:critical') ? ['critical'] : []
      body = method_tokens(file, line).map { |token| token[2] }.join
      reads = body.to_enum(:scan, /\b(?:File\.(?:read|readlines)|IO\.read|read_file)\s*\(?\s*['"]([^'"]+)['"]/).map do
        match = Regexp.last_match
        [match[1], match.begin(0)]
      end
      kind = nil
      reads.each do |path, offset|
        candidate = if path.match?(/(?:README|CHANGELOG|docs\/|\.(?:md|txt)\b)/i)
                      'doc-wording'
                    elsif path.match?(/\.(?:rb|rake|gemspec)\b/)
                      'source-text'
                    end
        next unless candidate

        line_start = (body.rindex("\n", offset) || -1) + 1
        line_end = body.index("\n", offset) || body.length
        same_line = body[line_start...line_end]
        assignment = body[0...offset].match(/\b([a-z_]\w*)\s*=\s*\z/)
        asserted = same_line.match?(/\b(?:assert(?:_\w+)?|must_equal|expect)\b/) ||
                   (assignment && body[offset..].match?(/\b(?:assert(?:_\w+)?|must_equal|expect)\b[^\n]*\b#{Regexp.escape(assignment[1])}\b/))
        if asserted
          kind = candidate
          break
        end
      end
      [tags, kind ? [{ 'test' => test_id, 'kind' => kind, 'line' => line }] : []]
    end

    def self.spawns_interpreter?(file, line)
      text = method_tokens(file, line).map { |token| token[2] }.join
      text.match?(/(?:system|spawn|exec|capture\d?|popen\d?|`)\s*\(?\s*['"]?(?:ruby\b|bin\/rails\b)/)
    end
  end
end
