// ==UserScript==
// @name               ChatGPT Exporter
// @name:zh-CN         ChatGPT Exporter
// @name:zh-TW         ChatGPT Exporter
// @namespace          pionxzh
// @version            2.33.0
// @author             pionxzh
// @description        Export ChatGPT conversations with one click — backup & share effortlessly!
// @description:zh-CN  一键导出 ChatGPT 对话，轻松备份与分享
// @description:zh-TW  一鍵導出 ChatGPT 對話，輕鬆備份與分享
// @license            MIT
// @icon               https://chatgpt.com/favicon.ico
// @downloadURL        https://raw.githubusercontent.com/psyche08/chatgpt-exporter/master/dist/chatgpt.user.js
// @updateURL          https://raw.githubusercontent.com/psyche08/chatgpt-exporter/master/dist/chatgpt.meta.js
// @match              https://chat.openai.com/
// @match              https://chat.openai.com/?*
// @match              https://chat.openai.com/c/*
// @match              https://chat.openai.com/g/*
// @match              https://chat.openai.com/gpts
// @match              https://chat.openai.com/gpts/*
// @match              https://chat.openai.com/share/*
// @match              https://chat.openai.com/share/*/continue
// @match              https://chatgpt.com/
// @match              https://chatgpt.com/?*
// @match              https://chatgpt.com/c/*
// @match              https://chatgpt.com/g/*
// @match              https://chatgpt.com/gpts
// @match              https://chatgpt.com/gpts/*
// @match              https://chatgpt.com/share/*
// @match              https://chatgpt.com/share/*/continue
// @require            https://cdn.jsdelivr.net/npm/jszip@3.9.1/dist/jszip.min.js
// @require            https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @grant              GM_deleteValue
// @grant              GM_getValue
// @grant              GM_setValue
// @grant              unsafeWindow
// @run-at             document-end
// ==/UserScript==