# Chat-first compact panel

The compact VibeSpace panel is a mirror, not a second chat owner. It shows every non-archived
chat in the signed-in workspace, keeps the canonical thread and composer interactive in both
surfaces, and never asks the user to move a chat back to the main window.

The panel contains only two top-level modes: **Chat** and **Terminals**. Chat is the default and
uses the available space as one continuous conversation surface. A small horizontally scrollable
chat strip selects threads; double-clicking a tab renames the canonical chat in place. New chats
are created through the existing lifecycle and remain ordinary workspace chats.

Terminal presentation retains the existing one-xterm-per-PTY safety boundary. Removing a terminal
from the compact panel keeps its PTY alive, but no Open Main App or Bring back control is exposed.

The supplied `C:\Users\viper\Downloads\index(12).html` is the visual authority for this bounded
surface: warm paper, restrained copper, a quiet teal counterpoint, and subtle grain. The reference
is expressed with existing CSS and a tiny inline SVG texture so no image download, dependency, or
background process is introduced. Existing themes remain authoritative through VibeSpace tokens.
