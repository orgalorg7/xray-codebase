package main

import (
	"net/http"

	"example.com/shop/store"
)

func main() {
	http.HandleFunc("GET /health", health)
	store.NewRepo().Find("x")
}

func health(w http.ResponseWriter, r *http.Request) {}
