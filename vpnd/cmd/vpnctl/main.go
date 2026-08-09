// Command vpnctl talks to vpnd from a terminal.
//
// It exists so the daemon can be exercised without the GUI: during
// development, and — more importantly — when a user reports "connecting
// forever" and somebody needs to find out whether the daemon, the tunnel or
// the app is at fault.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"time"

	"vpnd/internal/ipc"
	"vpnd/internal/protocol"
)

func main() {
	var (
		socketPath = flag.String("socket", ipc.DefaultSocketPath(), "path of the control socket")
		configPath = flag.String("config", "", "config file for `up`")
		server     = flag.String("server", "", "server address for `up`")
		timeout    = flag.Duration("timeout", 30*time.Second, "how long to wait")
	)
	flag.Parse()

	command := flag.Arg(0)
	if command == "" {
		fmt.Fprintln(os.Stderr, "usage: vpnctl [flags] version|status|up|down|watch")
		os.Exit(2)
	}

	if err := run(*socketPath, command, *configPath, *server, *timeout); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(socketPath, command, configPath, server string, timeout time.Duration) error {
	conn, err := net.DialTimeout("unix", socketPath, 5*time.Second)
	if err != nil {
		return fmt.Errorf("cannot reach vpnd at %s (is the service running?): %w", socketPath, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	encoder := protocol.NewEncoder(conn)
	decoder := protocol.NewDecoder(conn)

	request := protocol.Request{ID: 1}
	switch command {
	case "version", "status", "down":
		request.Method = command
	case "up":
		if configPath == "" {
			return fmt.Errorf("up needs -config")
		}
		config, readErr := os.ReadFile(configPath)
		if readErr != nil {
			return readErr
		}
		request.Method = protocol.MethodUp
		params, _ := json.Marshal(protocol.UpParams{
			Config:        string(config),
			ServerAddress: server,
		})
		request.Params = params
	case "watch":
		request.Method = protocol.MethodSubscribe
	default:
		return fmt.Errorf("unknown command %q", command)
	}

	if err := encoder.Encode(request); err != nil {
		return err
	}

	for {
		var frame json.RawMessage
		if err := decoder.Decode(&frame); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}

		var pretty map[string]any
		_ = json.Unmarshal(frame, &pretty)
		encoded, _ := json.MarshalIndent(pretty, "", "  ")
		fmt.Println(string(encoded))

		// Everything except `watch` is one request, one answer.
		if command != "watch" {
			if response, ok := pretty["ok"].(bool); ok && !response {
				os.Exit(1)
			}
			return nil
		}
	}
}
