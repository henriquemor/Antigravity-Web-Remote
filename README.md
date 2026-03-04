# 🚀 Antigravity Web Remote

<div align="center">
  <img width="700" alt="screenshot" src="https://github.com/user-attachments/assets/a416cf52-9ac7-481e-bec4-9b3078652095" />
  
  <br>
  
  **A real-time interface for monitoring and interacting with Antigravity chat sessions remotely.**
</div>

---

<div align="center">
  
[<img alt="Support Tip Jar" title="Cheers!" src="https://img.shields.io/badge/Buy_me_a_coffee-F5C300?style=flat&logo=undertale&logoColor=white" />](https://coinos.io/hmoraes) 

</div>

## ✨ Features

This fork extends the original project from [lukasz-wronski antigravity-shit-chat](https://github.com/lukasz-wronski/antigravity-shit-chat):

- 🌳 **File Explorer**: Browse your project files directly from the web interface
- ✏️ **Code Editor**: Edit files
- 🔄 **Git**: 
  - View **Git Status** and **Diffs**
  - **Stage/Unstage** files
  - **Commit** changes
  - **Sync** (Pull/Push) with remote repositories
- ✨ **UI**: typography and mobile optimizations.
- 🖱️ **Clicking**: Click buttons in the chat interface remotely (via [sanderd fork](https://github.com/sanderd/Antigravity-Shit-Chat/tree/feature/remote-button-click))
- 🖥️ Remote screen "streaming" and interactions. (mobile optimized only, for now)
---

note: the code was tested only on a Windows machine.

## 🛠️ Installation & Usage

### 1. Install Dependencies
Run this command in the project folder to install the necessary packages:
```bash
npm install
```

### 2. Start Antigravity in Debug Mode
Launch Antigravity with the remote debugging port enabled:
```bash
antigravity * --remote-debugging-port=9000
```
*(Note: You might see a warning about the flag, you can safely ignore it and close the terminal.)*

### 3. Start the Server
Run the Node.js server to start the web interface:
```bash
node server.js pin 123
```
The pin is optional for the remote jpg streaming interface, but it is recommended to use it to prevent unauthorized access from within your network.

### 4. Access the Interface
Open your browser and navigate to:
```
http://localhost:3000
```
> **Tip:** Use **Tailscale** to access your dev machine securely from external networks.

---

## 🔗 Credits & Acknowledgments

This project is a heavily modified fork based on the excellent work by [lukasz-wronski](https://github.com/lukasz-wronski/antigravity-shit-chat) and [Mario4272](https://github.com/Mario4272).


