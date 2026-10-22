use shop_core::Repo;

pub fn list() { let repo = Repo::new(); repo.find("x"); }
pub fn create() {}

#[get("/users/{id}")]
async fn get_user() -> String { String::new() }
