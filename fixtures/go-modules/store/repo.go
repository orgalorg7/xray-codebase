package store

import (
	"fmt"

	m "example.com/shop/models"
	"github.com/gin-gonic/gin"
)

// Keyed has a key.
type Keyed interface {
	Key() string
}

// Repo stores users.
type Repo struct {
	db *DB
}

type DB struct{}

func (d *DB) Query(q string) {}

func NewRepo() *Repo { return &Repo{db: &DB{}} }

func (r *Repo) Find(id string) *m.User {
	r.db.Query(id)
	u := m.Load(id)
	u.Save()
	fmt.Println(u)
	return u
}

func Routes(e *gin.Engine) {
	e.GET("/users/:id", show)
}

func show(c *gin.Context) {
	repo := NewRepo()
	repo.Find(c.Param("id"))
}
