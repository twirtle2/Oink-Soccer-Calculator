# Browser match engine

The browser simulation is compiled from the public `oink-soccer-common/v2` Go engine pinned in `go.mod` to commit `09aa7aeed148ad4df8b18f616479f4ac74d69094`. The selected matchup is converted to engine lineups and run in a web worker. The current lineup and each held item use the same seed sequence. Item scenarios replace the current boost; the client applies the reported effectiveness to each boost range before passing it to the engine. They do not predict opponent changes or future item expiry.

To rebuild, install Go 1.27.3, then from this directory run:

```sh
go test ./...
GOOS=js GOARCH=wasm go build -trimpath -o ../public/engine/oink-engine.wasm .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" ../public/engine/wasm_exec.js
```

The Go runtime JavaScript must come from the same Go version as the compiled WebAssembly. The production build serves the committed artifacts and does not require Go.
