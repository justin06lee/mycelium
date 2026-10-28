package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"example.com/inbox/internal/ui"
)

func main() {
	if _, err := tea.NewProgram(ui.New()).Run(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
