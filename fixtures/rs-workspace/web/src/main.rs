use shop_core::Repo;
use axum::{Router, routing::get};

mod handlers;

fn main() {
    let app = Router::new().route("/users", get(handlers::list).post(handlers::create));
    handlers::list();
}
