# frozen_string_literal: true

require 'digest'

module Cupel
  module Mutation
    class SourceError < StandardError; end

    class Source
      MAX_BYTES = 32 * 1024 * 1024
      HASH = /\Asha256:[0-9a-f]{64}\z/
      PRIVATE = /\A(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.ssh|\.aws|\.git|\.scratch|id_rsa|id_ed25519|credentials(?:[._-].*)?|secrets(?:[._-].*)?|private-keys(?:[._-].*)?)\z/i

      attr_reader :relative, :path, :text, :hash

      def initialize(root, relative, declared)
        @root = File.realpath(root)
        @relative = relative
        @declared = declared
        parts = relative.is_a?(String) ? relative.split('/', -1) : []
        raise SourceError, 'mutation source path is private or noncanonical' if parts.empty? ||
          !relative.end_with?('.rb') || relative.include?("\\") || relative.include?("\0") ||
          parts.any? { |part| part.empty? || part == '..' || part.start_with?('.') || part.match?(PRIVATE) ||
            %w[test tests spec specs vendor node_modules gems].include?(part) }
        raise SourceError, "mutation source hash is absent or noncanonical: #{relative}" unless declared.is_a?(String) && declared.match?(HASH)

        @path = File.join(@root, *parts)
        @identity, bytes, @hash = read_current
        raise SourceError, "mutation source changed: #{relative}: input hash differs" unless @hash == declared
        raise SourceError, "mutation source exceeds #{MAX_BYTES} bytes: #{relative}" if bytes.bytesize > MAX_BYTES
        @text = bytes.force_encoding(Encoding::UTF_8)
        raise SourceError, "mutation source is not UTF-8: #{relative}" unless @text.valid_encoding?
      end

      def assert_fresh!
        identity, _bytes, digest = read_current
        raise SourceError, "mutation source changed: #{@relative}" unless identity == @identity && digest == @hash && digest == @declared
        self
      end

      private

      def read_current
        root_now = File.realpath(@root)
        raise SourceError, 'mutation project root changed' unless root_now == @root
        cursor = @root
        @relative.split('/').each do |part|
          cursor = File.join(cursor, part)
          raise SourceError, "mutation source path contains symlink: #{@relative}" if File.symlink?(cursor)
        end
        real = File.realpath(@path)
        raise SourceError, "mutation source escaped root: #{@relative}" unless real == @path && real.start_with?("#{@root}/")
        stat = File.lstat(real)
        raise SourceError, "mutation source is not a single-link regular file: #{@relative}" unless stat.file? && stat.nlink == 1
        raise SourceError, "mutation source exceeds #{MAX_BYTES} bytes: #{@relative}" if stat.size > MAX_BYTES
        flags = File::RDONLY | File::BINARY | (File.const_defined?(:NOFOLLOW) ? File::NOFOLLOW : 0)
        bytes = File.open(real, flags) do |file|
          opened = file.stat
          # Windows Ruby gives an open file another device and index than its path, and has no NOFOLLOW: there the
          # path is checked again after the read instead.
          same = Gem.win_platform? ? opened.file? && opened.size == stat.size : opened.nlink == 1 && [opened.dev, opened.ino] == [stat.dev, stat.ino]
          raise SourceError, "mutation source changed during open: #{@relative}" unless opened.file? && same
          file.read
        end
        if Gem.win_platform?
          after = File.lstat(real)
          raise SourceError, "mutation source changed during read: #{@relative}" unless after.file? && after.nlink == 1 &&
            [after.dev, after.ino, after.size, after.mtime] == [stat.dev, stat.ino, stat.size, stat.mtime]
        end
        [[real, stat.dev, stat.ino], bytes, "sha256:#{Digest::SHA256.hexdigest(bytes)}"]
      rescue Errno::ENOENT, Errno::ELOOP, Errno::EACCES => error
        raise SourceError, "mutation source unreadable: #{@relative}: #{error.class}"
      end
    end
  end
end
