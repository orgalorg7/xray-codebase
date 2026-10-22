# A person.
class User < ApplicationRecord
  include Auditable
  attr_reader :id

  def initialize(id)
    @id = id
  end

  def save
    validate!
    audit
  end

  def self.find_by_id(id)
    new(id)
  end
end
