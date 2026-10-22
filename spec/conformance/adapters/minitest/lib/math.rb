# Branchy Ruby fixture.
module MathFixture
  OFFSET = 1

  def self.add(a, b)
    a + b + OFFSET
  end

  def self.classify(value)
    if value < 0
      :low
    else
      :ok
    end
  end

  def self.uncalled
    :unused
  end
end
