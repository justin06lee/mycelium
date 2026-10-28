package ui

import "strings"

type item struct {
	title string
}

func (i item) label() string {
	return strings.TrimSpace(i.title)
}

// list is the scrollable message list.
type list struct {
	items  []item
	cursor int
}

func newList(titles []string) list {
	l := list{}
	for _, t := range titles {
		l.items = append(l.items, item{title: t})
	}
	return l
}

func (l list) move(key string) list {
	switch key {
	case "up":
		l.cursor = clamp(l.cursor-1, len(l.items))
	case "down":
		l.cursor = clamp(l.cursor+1, len(l.items))
	}
	return l
}

func (l list) View() string {
	var rows []string
	for i, it := range l.items {
		rows = append(rows, l.row(i, it.label()))
	}
	return strings.Join(rows, "\n")
}

func (l list) row(i int, text string) string {
	if i == l.cursor {
		return styleSelected.Render("> " + text)
	}
	return "  " + text
}

func clamp(i, n int) int {
	return max(0, min(i, n-1))
}
