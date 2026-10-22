use crate::models::{User, Keyed};
use std::collections::HashMap;
use serde::Serialize;

pub struct Repo { users: HashMap<String, User>, db: Db }

struct Db;
impl Db { fn query(&self, _q: &str) {} }

impl Repo {
    pub fn new() -> Self { Repo { users: HashMap::new(), db: Db } }
    pub fn find(&self, id: &str) -> Option<User> {
        self.db.query(id);
        let u = User::load(id);
        u.save().ok();
        let k = u.key();
        Some(u)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds() { let r = Repo::new(); r.find("a"); }
}
