class UsersController < ApplicationController
  def show
    repo = Shop::UserRepo.new
    repo.find(params[:id])
    repo.count
  end

  def index; end
end
