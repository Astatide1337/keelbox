package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGreetingAndUnknownRoute(t *testing.T) {
	for _, tc := range []struct {
		path string
		code int
	}{{"/", http.StatusOK}, {"/missing", http.StatusNotFound}} {
		result := httptest.NewRecorder()
		greeting(result, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if result.Code != tc.code {
			t.Fatalf("%s: %d", tc.path, result.Code)
		}
		if tc.path == "/" && result.Body.String() != "Hello from Keelbox!\n" {
			t.Fatalf("unexpected message: %q", result.Body.String())
		}
	}
}
