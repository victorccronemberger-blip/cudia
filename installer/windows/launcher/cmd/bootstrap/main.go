package main

import (
	"cudia.local/windows-launcher/internal/client"
	"os"
)

func main() { os.Exit(client.Bootstrap(os.Args[1:])) }
