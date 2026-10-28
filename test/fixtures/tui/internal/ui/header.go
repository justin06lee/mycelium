package ui

import "fmt"

func (m Model) header() string {
	return styleTitle.Render("Inbox") + " " + badge(len(m.inbox.items))
}

func badge(n int) string {
	return styleMuted.Render(fmt.Sprintf("(%d)", n))
}

func footer() string {
	return styleMuted.Render("↑/↓ move · q quit")
}
