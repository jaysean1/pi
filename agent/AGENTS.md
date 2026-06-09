# Global Pi Instructions

- When creating or modifying persistent source, documentation, or config files, especially inside child Git repos, prefer `write` / `edit` over bash heredoc, `cat > file`, `tee`, shell redirection, or ad-hoc scripts that write files, so diff-review can track exact file changes. Use bash for discovery, `mkdir`, `chmod`, tests, Git commands, and temporary scratch files.
