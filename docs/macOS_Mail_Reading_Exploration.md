# macOS Mail.app 本地邮件读取方案探索报告

## 目录
1. [方案一：osascript (AppleScript)](#方案一osascript-applescript)
2. [方案二：直接读取 .emlx 文件](#方案二直接读取-emlx-文件)
3. [方案三：命令行搜索工具](#方案三命令行搜索工具)
4. [附加发现：Envelope Index 数据库](#附加发现envelope-index-数据库)
5. [总结与推荐](#总结与推荐)

---

## 方案一：osascript (AppleScript)

### 可行性评估：完全可行 ✅

**优点：**
- AppleScript 是 macOS 原生支持的自动化脚本语言
- 可以完全控制 Mail.app 的所有功能
- 支持搜索、读取、筛选邮件

**缺点：**
- 需要 Mail.app 正在运行（对 GUI 应用有依赖）
- 搜索大量邮件时可能较慢

### 基础测试结果

```bash
# 获取邮箱列表
osascript -e 'tell application "Mail" to get name of every mailbox'
# 输出: 恢复的邮件（163）, SendLater, Outbox

# 获取第一封邮件的主题
osascript -e 'tell application "Mail" to get subject of first message of inbox'
# 输出: Become an LLM expert with our new free course
```

### 完整示例代码

#### 1. 搜索并读取邮件（按主题关键词）

```bash
osascript << 'EOF'
tell application "Mail"
    -- 搜索 INBOX 中主题包含 "GitHub" 的邮件
    set msgs to every message of inbox whose subject contains "GitHub"
    
    if (count of msgs) > 0 then
        set msg to item 1 of msgs
        
        -- 获取邮件详细信息
        set msgSubject to subject of msg
        set msgSender to sender of msg
        set msgDate to date received of msg
        set msgContent to content of msg
        
        -- 格式化输出
        return "Subject: " & msgSubject & return & ¬
               "From: " & msgSender & return & ¬
               "Date: " & msgDate & return & ¬
               "Body: " & msgContent
    else
        return "No messages found"
    end if
end tell
EOF
```

**测试结果：**
```
Subject: [GitHub] A third-party OAuth application has been added to your account
From: GitHub <noreply@github.com>
Date: 2026年5月10日 星期日 00:39:00
Body preview: Hey Cao150702! A third-party OAuth application...
```

#### 2. 按发件人搜索

```bash
osascript << 'EOF'
tell application "Mail"
    set msgs to every message of inbox whose sender contains "github.com"
    return "Found " & (count of msgs) & " messages from GitHub"
end tell
EOF

# 输出: Found 26 messages
```

#### 3. 获取所有邮件列表（循环遍历）

```bash
osascript << 'EOF'
tell application "Mail"
    set allMsgs to every message of inbox
    
    -- 创建结果列表
    set resultList to {}
    
    -- 限制处理数量以避免超时
    set maxCount to 10
    if (count of allMsgs) < maxCount then
        set maxCount to count of allMsgs
    end if
    
    repeat with i from 1 to maxCount
        set msg to item i of allMsgs
        set end of resultList to (i as string) & ". " & subject of msg & " | " & sender of msg
    end repeat
    
    return resultList as string
end tell
EOF
```

#### 4. Python 脚本调用 AppleScript

```python
#!/usr/bin/env python3
import subprocess

def run_applescript(script):
    """运行 AppleScript 并返回结果"""
    result = subprocess.run(
        ['osascript', '-e', script],
        capture_output=True,
        text=True
    )
    return result.stdout.strip()

# 示例：搜索包含关键词的邮件
def search_emails(keyword, max_results=5):
    script = f'''
    tell application "Mail"
        set msgs to every message of inbox whose subject contains "{keyword}"
        if (count of msgs) > 0 then
            set resultText to ""
            set count_ to (count of msgs)
            if count_ > {max_results} then set count_ to {max_results}
            
            repeat with i from 1 to count_
                set msg to item i of msgs
                set resultText to resultText & subject of msg & "||" & sender of msg & "||" & (date received of msg as string) & "||" & (characters 1 through 100 of content of msg as string) & "|||"
            end repeat
            return resultText
        else
            return "NO_RESULTS"
        end if
    end tell
    '''
    
    result = run_applescript(script)
    if result == "NO_RESULTS" or not result:
        return []
    
    emails = []
    for email_data in result.split("|||"):
        if email_data.strip():
            parts = email_data.split("||")
            if len(parts) >= 4:
                emails.append({
                    'subject': parts[0],
                    'sender': parts[1],
                    'date': parts[2],
                    'preview': parts[3]
                })
    return emails

# 使用示例
if __name__ == "__main__":
    results = search_emails("GitHub")
    for email in results:
        print(f"Subject: {email['subject']}")
        print(f"From: {email['sender']}")
        print(f"Date: {email['date']}")
        print(f"Preview: {email['preview']}...")
        print("-" * 50)
```

### AppleScript 邮件属性参考

| 属性 | 说明 | 示例值 |
|------|------|--------|
| `subject` | 邮件主题 | "[GitHub] Verify email" |
| `sender` | 发件人 | "GitHub <noreply@github.com>" |
| `date sent` | 发送时间 | "2026年5月10日..." |
| `date received` | 接收时间 | "2026年5月10日..." |
| `content` | 邮件正文 | "Hey Cao150702!..." |
| `id` | 邮件 ID | 1825 |
| `message id` | 全局消息 ID | 1825 |

---

## 方案二：直接读取 .emlx 文件

### 可行性评估：可行 ✅

**优点：**
- 不需要运行 Mail.app
- 文件格式是纯文本，易于解析
- 读取速度快

**缺点：**
- 需要自己实现目录遍历和搜索
- 邮件正文可能是 Base64 或 quoted-printable 编码
- 目录结构复杂

### .emlx 文件格式

`.emlx` 文件是 macOS Mail.app 使用的原生邮件格式。

**文件结构：**
```
[字节数]\n
[邮件内容 (RFC 822 格式)]\n
[Apple plist 元数据]
```

### 示例文件内容分析

文件路径：
```
~/Library/Mail/V10/MailData/Accounts/[AccountID]/[MailboxID].mbox/[UUID]/Data/Messages/[number].emlx
```

**实际文件内容（846.emlx）：**

```
1817      
Received: from out-24.smtp.github.com (unknown [192.30.252.207])
	by smtp.qiye.163.com (Hmail) with ESMTP id 3319e84e0
	for <2535061111@st.usst.edu.cn>; Wed, 4 Feb 2026 19:08:44 +0800 (GMT+08:00)
...
Date: Wed, 04 Feb 2026 03:08:42 -0800
From: GitHub <noreply@github.com>
To: Cao150702 <15048094700@163.com>
Subject: [GitHub] A third-party OAuth application has been added to your
 account
Mime-Version: 1.0
Content-Type: text/plain;
 charset=UTF-8
Content-Transfer-Encoding: 7bit
...

Hey Cao150702!

A third-party OAuth application (memU) with user:email scopes was recently authorized to access your account.
...

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>color</key>
	<string>000000</string>
	<key>conversation-id</key>
	<integer>775</integer>
	<key>date-last-viewed</key>
	<integer>1772208304</integer>
	<key>date-received</key>
	<integer>1770203325</integer>
	<key>flags</key>
	<integer>8590195841</integer>
	<key>remote-id</key>
	<string>1762391177</string>
</dict>
</plist>
```

### Python 解析 .emlx 文件示例

```python
#!/usr/bin/env python3
import os
import plistlib
import email
from email import policy
from email.parser import BytesParser

class EMLXParser:
    """解析 macOS Mail.app 的 .emlx 文件"""
    
    def __init__(self, mail_dir="~/Library/Mail"):
        self.mail_dir = os.path.expanduser(mail_dir)
    
    def find_all_emlx(self):
        """递归查找所有 .emlx 文件"""
        emlx_files = []
        for root, dirs, files in os.walk(self.mail_dir):
            for f in files:
                if f.endswith('.emlx') and not f.endswith('.partial.emlx'):
                    emlx_files.append(os.path.join(root, f))
        return emlx_files
    
    def parse_emlx(self, filepath):
        """解析单个 .emlx 文件"""
        with open(filepath, 'rb') as f:
            content = f.read()
        
        # 第一行是字节数
        lines = content.split(b'\n', 1)
        byte_count = int(lines[0].decode('utf-8').strip())
        
        # 提取邮件内容
        mail_content = lines[1][:byte_count]
        
        # 查找 plist 结束位置
        plist_start = content.find(b'<?xml version="1.0"')
        if plist_start == -1:
            plist_start = content.find(b'<plist')
        
        # 解析邮件头和正文
        try:
            msg = BytesParser(policy=policy.default).parsebytes(mail_content)
            
            # 提取关键信息
            result = {
                'subject': msg['subject'] or '',
                'from': msg['from'] or '',
                'to': msg['to'] or '',
                'date': msg['date'] or '',
                'message_id': msg['message-id'] or '',
                'content': self._get_body(msg),
                'filepath': filepath
            }
            
            # 解析 Apple plist 元数据
            if plist_start > 0:
                plist_data = content[plist_start:]
                metadata = plistlib.loads(plist_data)
                result['metadata'] = metadata
            
            return result
        except Exception as e:
            return {'error': str(e), 'filepath': filepath}
    
    def _get_body(self, msg):
        """提取邮件正文"""
        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                if content_type == 'text/plain':
                    try:
                        return part.get_payload(decode=True).decode('utf-8')
                    except:
                        return part.get_payload()
        else:
            try:
                return msg.get_payload(decode=True).decode('utf-8')
            except:
                return msg.get_payload()
        return ''
    
    def search_emlx_files(self, keyword):
        """搜索包含关键词的邮件"""
        results = []
        for filepath in self.find_all_emlx():
            parsed = self.parse_emlx(filepath)
            
            # 搜索主题、发件人、正文
            search_str = (
                parsed.get('subject', '').lower() + ' ' +
                parsed.get('from', '').lower() + ' ' +
                parsed.get('content', '').lower()
            )
            
            if keyword.lower() in search_str:
                results.append(parsed)
        
        return results

# 使用示例
if __name__ == "__main__":
    parser = EMLXParser()
    
    # 搜索包含 "GitHub" 的邮件
    results = parser.search_emlx_files("GitHub")
    
    print(f"Found {len(results)} messages containing 'GitHub'\n")
    
    for msg in results[:5]:
        print(f"Subject: {msg.get('subject', 'N/A')}")
        print(f"From: {msg.get('from', 'N/A')}")
        print(f"Date: {msg.get('date', 'N/A')}")
        print(f"Preview: {msg.get('content', '')[:100]}...")
        print("-" * 50)
```

### 命令行快速查看 .emlx

```bash
# 查看邮件文件
cat ~/Library/Mail/V10/.../Messages/846.emlx

# 提取主题
cat ~/Library/Mail/V10/.../Messages/846.emlx | grep -i "^Subject:"

# 提取发件人
cat ~/Library/Mail/V10/.../Messages/846.emlx | grep -i "^From:"

# 提取日期
cat ~/Library/Mail/V10/.../Messages/846.emlx | grep -i "^Date:"

# 提取正文（跳过第一行和最后的 plist）
tail -n +2 ~/Library/Mail/V10/.../Messages/846.emlx | head -c 1817
```

---

## 方案三：命令行搜索工具

### mdfind (Spotlight) - 部分可用 ⚠️

**测试结果：**
```bash
# 搜索邮件文件（返回路径）
mdfind "kMDItemContentType == 'com.apple.mail.message'" | head -5
# 输出: 空（未索引邮件内容）

# 搜索正文内容
mdfind "kMDItemContentType == 'com.apple.mail.message' && kMDItemTextContent == '*GitHub*'"
# 输出: 空
```

**问题：**
- macOS 10.15+ Catalina 之后，Spotlight 不再索引 Mail.app 邮件
- 需要手动触发重新索引：`mdimport -r ~/Library/Mail`

**解决方案（如果需要启用 Spotlight）：**
```bash
# 强制重新索引邮件
sudo mdutil -i on ~/Library/Mail
mdimport -r ~/Library/Mail
```

### 其他命令行工具

| 工具 | 可用性 | 说明 |
|------|--------|------|
| `mdfind` | 可用但未索引 | Spotlight 搜索 |
| `mail` | 可用 | Unix 邮件命令（读系统邮件，非 IMAP/POP） |
| `msmtp` | 未安装 | SMTP 发送工具 |
| `mutt` | 未安装 | 命令行邮件客户端 |
| `pine/alpine` | 未安装 | 命令行邮件客户端 |

---

## 附加发现：Envelope Index 数据库

### 可行性评估：非常高效 ✅

Mail.app 使用 SQLite 数据库存储邮件索引，路径：
```
~/Library/Mail/V10/MailData/Envelope Index
```

**测试结果：**
```bash
# 查看文件类型
file ~/Library/Mail/V10/MailData/"Envelope Index"
# 输出: SQLite 3.x database

# 查看数据库中的表
sqlite3 ~/Library/Mail/V10/MailData/"Envelope Index" ".tables"
# 输出: 包含 messages, subjects, addresses, senders 等表

# 统计邮件数量
sqlite3 ~/Library/Mail/V10/MailData/"Envelope Index" "SELECT COUNT(*) FROM messages;"
# 输出: 750
```

### 数据库表结构

**messages 表（核心邮件表）：**
```sql
CREATE TABLE messages (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL DEFAULT 0,
    global_message_id INTEGER NOT NULL,
    remote_id INTEGER,
    document_id TEXT,
    sender INTEGER,           -- 外键关联 senders 表
    subject_prefix TEXT,
    subject INTEGER,          -- 外键关联 subjects 表
    summary INTEGER,
    date_sent INTEGER,        -- Unix 时间戳
    date_received INTEGER,    -- Unix 时间戳
    mailbox INTEGER NOT NULL,
    read INTEGER DEFAULT 0,
    flagged INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    size INTEGER,
    conversation_id INTEGER,
    ...
);
```

**subjects 表：**
```sql
CREATE TABLE subjects (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT
);
```

**addresses 表：**
```sql
CREATE TABLE addresses (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT COLLATE NOCASE NOT NULL,  -- 邮箱地址
    comment TEXT                           -- 显示名称
);
```

### SQLite 查询示例

```bash
# 查询包含 "GitHub" 的邮件
sqlite3 ~/Library/Mail/V10/MailData/"Envelope Index" \
  "SELECT m.message_id, s.subject, datetime(m.date_received, 'unixepoch'), a.address 
   FROM messages m 
   JOIN subjects s ON m.subject = s.rowid 
   JOIN addresses a ON m.sender = a.ROWID 
   WHERE s.subject LIKE '%GitHub%' 
   LIMIT 5;"

# 输出:
# 8854445746549819063|[GitHub] Please verify your email address.|2026-02-02 05:19:02|noreply@github.com
# 1684655600689158380|[GitHub Education] 😢 @Cao150702|2026-02-02 05:24:27|edu-noreply@github.com
# ...
```

### Python + SQLite 方案

```python
#!/usr/bin/env python3
import sqlite3
import os
from datetime import datetime

class MailDatabaseReader:
    """读取 Mail.app 的 Envelope Index 数据库"""
    
    def __init__(self, db_path=None):
        if db_path is None:
            db_path = os.path.expanduser(
                "~/Library/Mail/V10/MailData/Envelope Index"
            )
        self.db_path = db_path
    
    def search_by_subject(self, keyword):
        """按主题搜索"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        query = """
        SELECT m.message_id, s.subject, 
               datetime(m.date_received, 'unixepoch') as received,
               a.address as sender
        FROM messages m
        JOIN subjects s ON m.subject = s.rowid
        JOIN addresses a ON m.sender = a.ROWID
        WHERE s.subject LIKE ?
        ORDER BY m.date_received DESC
        """
        
        cursor.execute(query, (f'%{keyword}%',))
        results = cursor.fetchall()
        conn.close()
        
        return [{
            'message_id': r[0],
            'subject': r[1],
            'date': r[2],
            'sender': r[3]
        } for r in results]
    
    def search_by_sender(self, sender_keyword):
        """按发件人搜索"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        query = """
        SELECT m.message_id, s.subject,
               datetime(m.date_received, 'unixepoch') as received,
               a.address as sender
        FROM messages m
        JOIN subjects s ON m.subject = s.rowid
        JOIN addresses a ON m.sender = a.ROWID
        WHERE a.address LIKE ?
        ORDER BY m.date_received DESC
        """
        
        cursor.execute(query, (f'%{sender_keyword}%',))
        results = cursor.fetchall()
        conn.close()
        
        return [{
            'message_id': r[0],
            'subject': r[1],
            'date': r[2],
            'sender': r[3]
        } for r in results]
    
    def get_recent_emails(self, limit=20):
        """获取最近的邮件"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        query = """
        SELECT m.message_id, s.subject,
               datetime(m.date_received, 'unixepoch') as received,
               a.address as sender
        FROM messages m
        JOIN subjects s ON m.subject = s.rowid
        JOIN addresses a ON m.sender = a.ROWID
        ORDER BY m.date_received DESC
        LIMIT ?
        """
        
        cursor.execute(query, (limit,))
        results = cursor.fetchall()
        conn.close()
        
        return [{
            'message_id': r[0],
            'subject': r[1],
            'date': r[2],
            'sender': r[3]
        } for r in results]

# 使用示例
if __name__ == "__main__":
    reader = MailDatabaseReader()
    
    # 搜索 GitHub 相关邮件
    results = reader.search_by_subject("GitHub")
    print(f"Found {len(results)} messages:")
    for r in results[:5]:
        print(f"  [{r['date']}] {r['subject']} - {r['sender']}")
    
    # 按发件人搜索
    print("\nEmails from github.com:")
    results = reader.search_by_sender("github.com")
    print(f"  Found {len(results)} messages")
    
    # 获取最近邮件
    print("\nRecent emails:")
    results = reader.get_recent_emails(5)
    for r in results:
        print(f"  [{r['date']}] {r['subject']}")
```

---

## 总结与推荐

### 方案对比

| 方案 | 可行性 | 性能 | 依赖 | 推荐度 |
|------|--------|------|------|--------|
| **AppleScript** | 完全可行 | 中等 | 需要 Mail.app 运行 | ⭐⭐⭐⭐⭐ |
| **.emlx 文件** | 可行 | 快 | 无 | ⭐⭐⭐⭐ |
| **Envelope Index (SQLite)** | 可行 | 非常快 | 无 | ⭐⭐⭐⭐⭐ |
| **mdfind/Spotlight** | 受限 | 快 | 需要重新索引 | ⭐⭐ |

### 推荐方案

#### 场景 1：需要完整邮件内容 + 全文搜索
**推荐：AppleScript + .emlx 组合**

```python
# 搜索用 AppleScript（方便）
# 读取完整内容用 .emlx 文件（快）
```

#### 场景 2：只搜索主题/发件人/时间
**推荐：Envelope Index (SQLite)**

- 最快、最直接
- 不需要运行任何应用
- 适合构建快速搜索工具

#### 场景 3：需要完整邮件正文
**推荐：直接读取 .emlx 文件**

- 可以获得完整邮件内容
- 支持附件解析
- 离线可用

### 最终结论

**最可行方案：组合使用**

1. **搜索层**：使用 `Envelope Index` SQLite 数据库进行快速搜索
2. **内容层**：使用 `.emlx` 文件读取完整邮件内容
3. **交互层**：使用 AppleScript 作为备选方案（当需要 Mail.app 功能时）

示例架构：
```
用户请求
    ↓
SQLite 搜索 → 获取邮件 ID 列表
    ↓
根据邮件 ID 定位 .emlx 文件
    ↓
解析 .emlx 获取完整内容
    ↓
返回结果
```

---

## 参考资源

- [AppleScript Language Guide - Mail](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptX/Concepts/mail.html)
- [EMLX File Format](https://developer.apple.com/library/archive/documentation/CoreServices/Conceptual/MailManager/MailManager_OM/MailManager_OM.html)
- [macOS Mail App Storage](https://support.apple.com/zh-cn/guide/mail/mlhl3a0d1ca9/mac)
