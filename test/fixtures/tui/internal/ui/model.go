package ui

import tea "github.com/charmbracelet/bubbletea"

// Model is the whole inbox screen.
type Model struct {
	inbox  list
	width  int
	height int
}

func New() Model {
	return Model{inbox: newList([]string{"Welcome", "Invoice", "Lunch?"})}
}

func (m Model) Init() tea.Cmd { return nil }

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case tea.KeyMsg:
		if msg.String() == "q" {
			return m, tea.Quit
		}
		m.inbox = m.inbox.move(msg.String())
	}
	return m, nil
}

func (m Model) View() string {
	return m.header() + "\n" + m.inbox.View() + "\n" + footer()
}
