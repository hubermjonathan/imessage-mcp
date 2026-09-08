# Sends argv item 1 as an iMessage to the handle in argv item 2.
#
# Kept as a fixed script file and invoked with arguments, so message content is
# never interpolated into this source. No `activate`: sending must not steal focus.

on run argv
  tell application "Messages"
    set svc to 1st service whose service type = iMessage
    send item 1 of argv to buddy (item 2 of argv) of svc
  end tell
end run
