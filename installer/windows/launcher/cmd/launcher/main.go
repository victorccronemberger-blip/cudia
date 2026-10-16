package main

import (
	"cudia.local/windows-launcher/internal/client"
	"os"
)

func main() { os.Exit(client.Launcher(os.Args[1:])) }
