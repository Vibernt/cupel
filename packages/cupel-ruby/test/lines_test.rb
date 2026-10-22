# frozen_string_literal: true

require 'minitest/autorun'
require 'tmpdir'
require 'fileutils'
require_relative '../lib/cupel/lines'

class LinesTest < Minitest::Test
  def test_scope_and_coverable_lines
    Dir.mktmpdir('cupel-ruby-lines-') do |root|
      %w[lib test spec vendor .hidden].each { |dir| FileUtils.mkdir_p(File.join(root, dir)) }
      %w[lib/a.rb test/a.rb spec/a.rb vendor/a.rb .hidden/a.rb].each do |path|
        File.write(File.join(root, path), "# comment\nmodule A\n  X = 1\nend\n")
      end
      outside = File.join(File.dirname(root), 'external.rb')
      File.write(outside, 'X = 1')
      File.symlink(outside, File.join(root, 'lib/outside.rb'))
      assert_equal({ 'lib/a.rb' => { 'coverable' => '2-3' } }, Cupel::Lines.scan(root))
    ensure
      FileUtils.rm_f(outside) if outside
    end
  end
end
