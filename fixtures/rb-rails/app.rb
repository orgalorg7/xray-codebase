require_relative "app/services/user_repo"

get "/health" do
  Shop::UserRepo.new.find(1)
end
