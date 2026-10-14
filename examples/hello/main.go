// The hello application belongs to this example; Keelbox does not generate it.
package main

import (
	"embed"
	"fmt"
	"log"
	"net/http"
	"time"
)

//go:embed message.txt
var content embed.FS

func greeting(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	message, err := content.ReadFile("message.txt")
	if err != nil {
		http.Error(w, "message unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if _, err = fmt.Fprint(w, string(message)); err != nil {
		log.Printf("response: %v", err)
	}
	log.Printf("%s %s", r.Method, r.URL.Path)
}

func main() {
	server := &http.Server{Addr: ":8080", Handler: http.HandlerFunc(greeting), ReadHeaderTimeout: 5 * time.Second}
	log.Print("hello listening on :8080")
	log.Fatal(server.ListenAndServe())
}
