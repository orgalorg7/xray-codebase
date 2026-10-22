/// A person.
#[derive(Debug)]
pub struct User { pub id: String }

impl User {
    pub fn load(id: &str) -> Self { User { id: id.to_string() } }
    pub fn save(&self) -> Result<(), String> { validate(self); Ok(()) }
}

fn validate(_u: &User) {}

pub trait Keyed { fn key(&self) -> String; }

impl Keyed for User { fn key(&self) -> String { self.id.clone() } }
