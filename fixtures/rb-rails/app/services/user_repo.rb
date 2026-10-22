require "json"
require "redis"

module Shop
  class UserRepo
    def initialize
      @store = Store.new
    end

    def find(id)
      user = User.find_by_id(id)
      user.save
      @store.put(id)
      User.new(id).save
      user
    end
  end

  class Store
    def put(key); end
  end
end
