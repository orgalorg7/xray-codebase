package models

// User is a customer.
type User struct {
	Base
	ID string
}

// Base holds shared fields.
type Base struct{}

func (b *Base) Touch() {}

// Load builds a user.
func Load(id string) *User { return &User{ID: id} }

func (u *User) Save() error {
	u.Touch()
	return nil
}

func (u *User) Key() string { return u.ID }
