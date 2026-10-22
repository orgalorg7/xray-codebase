import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import { analyzeProject } from "@xray/testkit";
import { it } from "vitest";
import { createGoPlugin } from "../src/index.js";

it("go", async () => {
  const g = await analyzeProject(createGoPlugin(), {
    "go.mod": "module example.com/app\n\ngo 1.22\n",
    "models/user.go":
      "package models\n\n// User is a person.\ntype User struct { ID string }\n\nfunc Load(id string) *User { return &User{ID: id} }\n\nfunc (u *User) Save() error { return nil }\n",
    "store/repo.go": `package store

import (
	"fmt"
	m "example.com/app/models"
	"github.com/gin-gonic/gin"
)

// Repo stores users.
type Repo struct {
	db *DB
}

type DB struct{}

func (d *DB) Query(q string) {}

type Finder interface {
	Find(id string) (*m.User, error)
}

func (r *Repo) Find(id string) (*m.User, error) {
	u := &m.User{ID: id}
	r.db.Query(id)
	u.Save()
	fmt.Println(u)
	return m.Load(id), nil
}

func NewRepo() *Repo { return &Repo{} }

func Routes(r *gin.Engine) { r.GET("/users/:id", handler) }

func handler(c *gin.Context) { x := NewRepo(); x.Find("a") }
`,
  });
  require("node:fs").writeFileSync(
    "/tmp/claude-1000/-home-nehad-Desktop-xray/d9b07418-cecf-4cb8-9ee9-5e6c21921ca2/scratchpad/go-out.txt",
    [
      ...g.keys().filter((k) => !k.includes("contains")),
      "---",
      ...g.nodes.map((n) => `${n.id} ${n.kind}${n.doc ? " doc" : ""}`),
      "---",
      JSON.stringify(g.diagnostics),
    ].join("\n"),
  );
});
