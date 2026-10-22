Rails.application.routes.draw do
  get "/users/:id", to: "users#show"
  resources :users, only: [:index]
  namespace :admin do
    resources :reports
  end
end
