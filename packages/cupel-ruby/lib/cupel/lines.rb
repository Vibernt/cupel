# frozen_string_literal: true

require 'coverage'

module Cupel
  module Lines
    EXCLUDED = %w[test tests spec specs vendor node_modules gems .bundle].freeze

    def self.source?(root, path)
      absolute = File.realpath(path)
      relative = absolute.delete_prefix("#{File.realpath(root)}/")
      return false if relative == absolute || !relative.end_with?('.rb')

      relative.split('/').none? { |part| part.start_with?('.') || EXCLUDED.include?(part) }
    rescue Errno::ENOENT
      false
    end

    def self.scan(root)
      Dir.glob('**/*.rb', File::FNM_DOTMATCH, base: root).sort.each_with_object({}) do |relative, sources|
        absolute = File.join(root, relative)
        next unless File.file?(absolute) && !File.symlink?(absolute) && source?(root, absolute)

        stub = Coverage.line_stub(absolute)
        sources[relative.tr(File::SEPARATOR, '/')] = { 'coverable' => encode(stub.each_index.filter_map { |i| i + 1 unless stub[i].nil? }) }
      end
    end

    def self.encode(lines)
      groups = []
      lines.uniq.sort.each do |line|
        if groups.last && groups.last[1] + 1 == line
          groups.last[1] = line
        else
          groups << [line, line]
        end
      end
      groups.map { |a, b| a == b ? a.to_s : "#{a}-#{b}" }.join(',')
    end

    def self.covered(raw, root, sources)
      raw.each_with_object({}) do |(path, data), found|
        next unless data.is_a?(Hash) && data['lines'] && source?(root, path)

        relative = File.realpath(path).delete_prefix("#{File.realpath(root)}/").tr(File::SEPARATOR, '/')
        next unless sources.key?(relative)

        lines = data['lines'].each_index.filter_map { |i| i + 1 if data['lines'][i].to_i.positive? }
        found[relative] = encode(lines) unless lines.empty?
      end.sort.to_h
    end
  end
end
