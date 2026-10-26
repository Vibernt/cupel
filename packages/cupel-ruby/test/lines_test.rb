# frozen_string_literal: true

require 'minitest/autorun'
require 'tmpdir'
require 'fileutils'
require_relative '../lib/cupel/lines'

class LinesTest < Minitest::Test
  def test_scope_and_coverable_lines
    Dir.mktmpdir('cupel-ruby-lines-') do |root|
      %w[lib test spec vendor .hidden].each { |dir| FileUtils.mkdir_p(File.join(root, dir)) }
      %w[lib/a.rb test/a.rb spec/a.rb vendor/a.rb .hidden/a.rb lib/credentials.rb].each do |path|
        File.write(File.join(root, path), "# comment\nmodule A\n  X = 1\nend\n")
      end
      outside = File.join(File.dirname(root), 'external.rb')
      File.write(outside, 'X = 1')
      File.symlink(outside, File.join(root, 'lib/outside.rb'))
      assert_equal({ 'lib/a.rb' => { 'coverable' => '2-3',
                                     'hash' => 'sha256:ad01ee8979a59222863aecf4be85b03f0cc435db65e0c3ddb72ee2c9c0adef53' } },
                   Cupel::Lines.scan(root))
    ensure
      FileUtils.rm_f(outside) if outside
    end
  end

  def test_covered_accepts_compact_and_full_line_data
    Dir.mktmpdir('cupel-ruby-lines-') do |root|
      FileUtils.mkdir_p(File.join(root, 'lib'))
      path = File.join(root, 'lib/a.rb')
      File.write(path, "module A\n  X = 1\n  Y = 2\nend\n")
      sources = { 'lib/a.rb' => { 'coverable' => '1-3' } }
      full = Cupel::Lines.covered({ path => { 'lines' => [1, 0, 2, nil] } }, root, sources)
      compact = Cupel::Lines.covered({ path => { 'covered' => [1, 3] } }, root, sources)
      assert_equal({ 'lib/a.rb' => '1,3' }, full)
      assert_equal(full, compact)
    end
  end
end
