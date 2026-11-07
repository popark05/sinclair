package io.sinclair.helper;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 접근성 트리를 packages/protocol 의 SemanticNode 모양으로 직렬화한다.
 * ref 는 이 dump 안에서만 유효한 DFS 순번(@e0, @e1, …)이다.
 */
final class TreeDumper {
    private static final int MAX_DEPTH = 64;
    private final AccessibilityService service;
    private int nextRef = 0;

    TreeDumper(AccessibilityService service) {
        this.service = service;
    }

    JSONObject dumpActiveWindow() throws JSONException {
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) {
            JSONObject empty = new JSONObject();
            empty.put("ref", "@e0");
            empty.put("role", "root");
            empty.put("name", "(활성 창 없음)");
            return empty;
        }
        try {
            return toNode(root, 0);
        } finally {
            recycle(root);
        }
    }

    private JSONObject toNode(AccessibilityNodeInfo node, int depth) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("ref", "@e" + (nextRef++));
        o.put("role", roleOf(node));

        CharSequence desc = node.getContentDescription();
        if (desc != null && desc.length() > 0) o.put("name", desc.toString());
        CharSequence text = node.getText();
        if (text != null && text.length() > 0) {
            // 비밀번호 필드의 내용은 에이전트에게 노출하지 않는다(REVIEW.md: secure 필드 redaction).
            o.put("text", node.isPassword() ? "" : text.toString());
        }
        String id = node.getViewIdResourceName();
        if (id != null && !id.isEmpty()) o.put("testId", id);
        CharSequence hint = node.getHintText();
        if (hint != null && hint.length() > 0) o.put("placeholder", hint.toString());

        Rect r = new Rect();
        node.getBoundsInScreen(r);
        JSONObject rect = new JSONObject();
        rect.put("x", r.left);
        rect.put("y", r.top);
        rect.put("width", Math.max(0, r.width()));
        rect.put("height", Math.max(0, r.height()));
        o.put("rect", rect);

        JSONObject states = new JSONObject();
        if (node.isFocused()) states.put("focused", true);
        if (node.isSelected()) states.put("selected", true);
        if (node.isCheckable() && node.isChecked()) states.put("checked", true);
        if (!node.isEnabled()) states.put("disabled", true);
        if (node.isPassword()) states.put("secure", true);
        if (states.length() > 0) o.put("states", states);

        if (depth < MAX_DEPTH) {
            JSONArray children = new JSONArray();
            int count = node.getChildCount();
            for (int i = 0; i < count; i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child == null) continue;
                try {
                    if (child.isVisibleToUser()) children.put(toNode(child, depth + 1));
                } finally {
                    recycle(child);
                }
            }
            if (children.length() > 0) o.put("children", children);
        }
        return o;
    }

    /** className → 러너의 locator 가 쓰는 역할 이름. 모르는 클래스는 상호작용 여부로 button/group 을 고른다. */
    private static String roleOf(AccessibilityNodeInfo node) {
        CharSequence cs = node.getClassName();
        String cls = cs == null ? "" : cs.toString();
        String simple = cls.substring(cls.lastIndexOf('.') + 1);
        if (simple.contains("EditText") || simple.contains("AutoCompleteTextView")) return "textbox";
        if (simple.contains("CheckBox")) return "checkbox";
        if (simple.contains("Switch") || simple.contains("ToggleButton")) return "switch";
        if (simple.contains("RadioButton")) return "radio";
        if (simple.contains("Button")) return "button";
        if (simple.contains("ImageView")) return node.isClickable() ? "button" : "image";
        if (simple.contains("TextView")) return node.isClickable() ? "button" : "text";
        if (simple.contains("RecyclerView") || simple.contains("ListView") || simple.contains("GridView")) return "list";
        if (simple.contains("ScrollView") || simple.contains("ViewPager")) return "scrollable";
        if (simple.contains("WebView")) return "webview";
        if (simple.contains("SeekBar") || simple.contains("ProgressBar")) return "slider";
        if (simple.contains("Spinner")) return "combobox";
        if (simple.contains("Tab")) return "tab";
        if (node.isClickable()) return "button";
        return node.getChildCount() > 0 ? "group" : "view";
    }

    @SuppressWarnings("deprecation")
    private static void recycle(AccessibilityNodeInfo node) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) node.recycle();
    }
}
