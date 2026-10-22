require_relative "../app/services/user_repo"

RSpec.describe Shop::UserRepo do
  describe "#find" do
    it "finds users" do
      Shop::UserRepo.new.find(1)
    end
  end
end
