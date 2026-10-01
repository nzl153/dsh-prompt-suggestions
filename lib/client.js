// DSH 把各插件的 client.js 拼成一个包加载，必须用 __ModuleLoader__ 的注册格式，不能是 ES 模块
window.__ModuleLoader__.load({
	id: "dsh-prompt-suggestions",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const SETTLE_MS = 300;
		const POLL_MS = 2500;

		// 和官方 client-connection 的 createWebConnectionRpc 同一个信封格式；
		// 桌面端的请求要走页面注入的 __DSH_TRANSPORT__，网页版没有它，用同源 fetch
		async function requestSuggestion(sessionId, signal) {
			const rpcId = crypto.randomUUID();
			const transport = globalThis.__DSH_TRANSPORT__;
			const send = typeof transport?.fetch === "function" ? transport.fetch : (input, init) => fetch(input, init);
			const response = await send("api/prompt-suggestions/suggest", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "client-request", rpcId, method: "suggest", payload: { sessionId } }),
				signal
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = await response.json();
			if (body?.rpcId !== rpcId || body.result?.ok !== true) return "";
			return typeof body.result.value?.text === "string" ? body.result.value.text : "";
		}

		function findEditor(anchor) {
			let node = anchor?.parentElement;
			for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
				const editor = node.querySelector('[contenteditable="true"]');
				if (editor) return editor;
			}
			return null;
		}

		// 官方占位提示和编辑器是兄弟节点，只在草稿为空时渲染
		function findPlaceholder(editor) {
			return editor?.parentElement?.querySelector('[class*="_placeholder"]') ?? null;
		}

		// / 命令、@ 引用的弹出菜单开着的时候 Tab 归它们
		function menuOpen() {
			return [...document.querySelectorAll('[role="listbox"], [role="menu"]')].some((el) => el.offsetParent !== null);
		}

		function createGhost() {
			const el = document.createElement("div");
			el.setAttribute("aria-hidden", "true");
			el.dataset.promptSuggestions = "";
			Object.assign(el.style, {
				position: "absolute",
				pointerEvents: "none",
				overflow: "hidden",
				whiteSpace: "nowrap",
				textOverflow: "ellipsis",
				display: "none"
			});
			const text = document.createElement("span");
			const key = document.createElement("span");
			key.textContent = "Tab";
			Object.assign(key.style, {
				marginLeft: "8px",
				padding: "0 5px",
				border: "1px solid currentColor",
				borderRadius: "4px",
				fontSize: "11px",
				lineHeight: "16px",
				display: "inline-block",
				verticalAlign: "1px",
				opacity: "0.7"
			});
			el.append(text, key);
			return { el, text };
		}

		function TabComplete({ sessionId, inputActions, useInput, useConversation }) {
			const draft = useInput((state) => state.draft);
			const phase = useInput((state) => state.phase);
			// 对话一有变化（新回复、流式输出）就换一个引用，用来作废旧建议
			const conversation = typeof useConversation === "function" ? useConversation((state) => state) : undefined;
			const anchor = React.useRef(null);
			const [suggestion, setSuggestion] = React.useState("");
			const [pollTick, setPollTick] = React.useState(0);
			const composing = React.useRef(false);
			const dismissed = React.useRef("");
			const ghost = React.useMemo(createGhost, []);

			const empty = draft === "" && phase === "plain";
			const visible = empty && suggestion !== "" && suggestion !== dismissed.current;

			React.useEffect(() => () => ghost.el.remove(), [ghost]);

			// 对话变了先撤掉旧建议，等它安静下来再问后台
			React.useEffect(() => {
				setSuggestion("");
			}, [sessionId, conversation]);

			React.useEffect(() => {
				if (!empty) return;
				const controller = new AbortController();
				const timer = setTimeout(async () => {
					try {
						const text = await requestSuggestion(sessionId, controller.signal);
						if (!controller.signal.aborted) setSuggestion(text);
					} catch {}
				}, SETTLE_MS);
				return () => {
					clearTimeout(timer);
					controller.abort();
				};
			}, [sessionId, conversation, empty, pollTick]);

			// 拿不到对话 hook 时退回轮询
			React.useEffect(() => {
				if (conversation !== undefined || !empty) return;
				const timer = setInterval(() => setPollTick((n) => n + 1), POLL_MS);
				return () => clearInterval(timer);
			}, [conversation, empty]);

			// 显示：放进占位提示所在的容器、占它的位置，并把它藏起来
			// 挂到 body 上会被应用根节点的层叠上下文盖住
			React.useEffect(() => {
				const editor = findEditor(anchor.current);
				const placeholder = findPlaceholder(editor);
				if (!visible || !editor || !placeholder) {
					ghost.el.style.display = "none";
					return;
				}
				ghost.text.textContent = suggestion;
				placeholder.parentElement.appendChild(ghost.el);
				const style = getComputedStyle(placeholder);
				Object.assign(ghost.el.style, {
					display: "block",
					top: style.top,
					left: style.left,
					right: style.right,
					font: style.font,
					color: style.color
				});
				placeholder.style.visibility = "hidden";
				return () => {
					placeholder.style.visibility = "";
					ghost.el.style.display = "none";
				};
			}, [visible, suggestion, ghost]);

			// Tab 接受、Esc 忽略；输入法组字期间一律不管
			React.useEffect(() => {
				if (!visible) return;
				const editor = findEditor(anchor.current);
				if (!editor) return;
				const onCompositionStart = () => {
					composing.current = true;
				};
				const onCompositionEnd = () => {
					composing.current = false;
				};
				const onKeyDown = (event) => {
					if (event.target !== editor && !editor.contains(event.target)) return;
					if (event.isComposing || event.keyCode === 229 || composing.current) return;
					if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
						if (menuOpen()) return;
						event.preventDefault();
						event.stopImmediatePropagation();
						inputActions.insertText(suggestion, inputActions.captureInsertion());
					} else if (event.key === "Escape") {
						event.preventDefault();
						event.stopImmediatePropagation();
						dismissed.current = suggestion;
						setSuggestion("");
					}
				};
				editor.addEventListener("compositionstart", onCompositionStart);
				editor.addEventListener("compositionend", onCompositionEnd);
				document.addEventListener("keydown", onKeyDown, true);
				return () => {
					editor.removeEventListener("compositionstart", onCompositionStart);
					editor.removeEventListener("compositionend", onCompositionEnd);
					document.removeEventListener("keydown", onKeyDown, true);
				};
			}, [visible, suggestion, inputActions]);

			return React.createElement("span", { ref: anchor, hidden: true });
		}

		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
				name: "conversation.input.overlay",
				id: "prompt-suggestions",
				order: 50
			}, TabComplete));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
