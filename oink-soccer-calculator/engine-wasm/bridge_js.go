//go:build js && wasm

package main

import (
	"encoding/json"
	"syscall/js"
)

func main() {
	js.Global().Set("runOinkMatches", js.FuncOf(func(_ js.Value, args []js.Value) interface{} {
		var req request
		if len(args) != 1 {
			return `{"error":"missing request"}`
		}
		if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
			b, _ := json.Marshal(map[string]string{"error": err.Error()})
			return string(b)
		}
		result, err := runSim(req)
		if err != nil {
			b, _ := json.Marshal(map[string]string{"error": err.Error()})
			return string(b)
		}
		b, _ := json.Marshal(map[string]interface{}{"results": result})
		return string(b)
	}))
	select {}
}
