param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WeChatNativeInput {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
  public static IntPtr FindTopLevelWindow(int processId, string exactTitle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint ownerProcessId;
      GetWindowThreadProcessId(hWnd, out ownerProcessId);
      if (ownerProcessId != (uint)processId || !IsWindowVisible(hWnd)) return true;
      int length = GetWindowTextLength(hWnd);
      var title = new StringBuilder(Math.Max(length + 1, 2));
      GetWindowText(hWnd, title, title.Capacity);
      if (!String.Equals(title.ToString(), exactTitle, StringComparison.Ordinal)) return true;
      found = hWnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@

$Tree = [System.Windows.Automation.TreeScope]
$Auto = [System.Windows.Automation.AutomationElement]
$ControlType = [System.Windows.Automation.ControlType]
$NameProperty = [System.Windows.Automation.AutomationElement]::NameProperty
$ControlTypeProperty = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$AutomationIdProperty = [System.Windows.Automation.AutomationElement]::AutomationIdProperty

function Write-ProgressEvent {
  param([string]$Phase, [int]$Progress, [string]$Message, [int]$SearchCards = 0, [int]$Scanned = 0, [int]$AiCandidates = 0)
  $payload = [ordered]@{
    phase = $Phase; progress = $Progress; message = $Message
    searchCardCount = $SearchCards; scannedCount = $Scanned; aiCandidateCount = $AiCandidates
  }
  Write-Output ('PROGRESS ' + ($payload | ConvertTo-Json -Compress))
}

function Find-One {
  param($Root, $Type, [string]$Name, [string]$AutomationId)
  $conditions = [System.Collections.Generic.List[System.Windows.Automation.Condition]]::new()
  if ($null -ne $Type) { $conditions.Add([System.Windows.Automation.PropertyCondition]::new($ControlTypeProperty, $Type)) }
  if ($Name) { $conditions.Add([System.Windows.Automation.PropertyCondition]::new($NameProperty, $Name)) }
  if ($AutomationId) { $conditions.Add([System.Windows.Automation.PropertyCondition]::new($AutomationIdProperty, $AutomationId)) }
  if ($conditions.Count -eq 0) { $condition = [System.Windows.Automation.Condition]::TrueCondition }
  elseif ($conditions.Count -eq 1) { $condition = $conditions[0] }
  else { $condition = [System.Windows.Automation.AndCondition]::new($conditions.ToArray()) }
  return $Root.FindFirst($Tree::Descendants, $condition)
}

function Find-All {
  param($Root, $Type)
  $condition = if ($null -eq $Type) { [System.Windows.Automation.Condition]::TrueCondition } else { [System.Windows.Automation.PropertyCondition]::new($ControlTypeProperty, $Type) }
  return $Root.FindAll($Tree::Descendants, $condition)
}

function Click-Point {
  param([double]$X, [double]$Y)
  [System.Windows.Forms.Cursor]::Position = [System.Drawing.Point]::new([int]$X, [int]$Y)
  Start-Sleep -Milliseconds 80
  [WeChatNativeInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [WeChatNativeInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Click-Element {
  param($Element)
  if ($null -eq $Element) { return $false }
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return $true
  } catch {
    try {
      $rect = $Element.Current.BoundingRectangle
      if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
        Click-Point ($rect.Left + $rect.Width / 2) ($rect.Top + $rect.Height / 2)
        return $true
      }
    } catch {}
  }
  return $false
}

function Press-Key {
  param([byte]$Key)
  [WeChatNativeInput]::keybd_event($Key, 0, 0, [UIntPtr]::Zero)
  [WeChatNativeInput]::keybd_event($Key, 0, 2, [UIntPtr]::Zero)
}

function Scroll-SearchRow {
  param([double]$X, [double]$Y)
  [System.Windows.Forms.Cursor]::Position = [System.Drawing.Point]::new([int]$X, [int]$Y)
  [WeChatNativeInput]::mouse_event(0x0800, 0, 0, -120, [UIntPtr]::Zero)
}

function Press-CtrlW {
  [WeChatNativeInput]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  [WeChatNativeInput]::keybd_event(0x57, 0, 0, [UIntPtr]::Zero)
  [WeChatNativeInput]::keybd_event(0x57, 0, 2, [UIntPtr]::Zero)
  [WeChatNativeInput]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
}

function Get-WindowRectangle {
  param([IntPtr]$Handle)
  $rect = [WeChatNativeInput+RECT]::new()
  if (-not [WeChatNativeInput]::GetWindowRect($Handle, [ref]$rect)) { throw '无法读取微信搜索窗口位置。' }
  return $rect
}

function Get-ChannelsHomeWindow {
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    foreach ($process in @(Get-Process WeChatAppEx -ErrorAction SilentlyContinue)) {
      try {
        $handle = [WeChatNativeInput]::FindTopLevelWindow($process.Id, '微信')
        if ($handle -eq [IntPtr]::Zero) { continue }
        $root = $Auto::FromHandle($handle)
        $document = Find-One $root $ControlType::Document '视频号' ''
        if ($null -eq $document) {
          $channelsTab = Find-One $root $null '视频号' ''
          if ($null -ne $channelsTab) {
            Click-Element $channelsTab | Out-Null
            Start-Sleep -Milliseconds 350
            $root = $Auto::FromHandle($handle)
            $document = Find-One $root $ControlType::Document '视频号' ''
          }
        }
        if ($null -ne $document) {
          return [pscustomobject]@{ Process = $process; Root = $root; Document = $document; Handle = $handle }
        }
      } catch {}
    }
    Start-Sleep -Milliseconds 300
  } while ([DateTime]::UtcNow -lt $deadline)
  throw '未找到已打开的「视频号」页面。请先在微信电脑版打开视频号，并保持该标签页存在。'
}

function Open-ChannelsKeywordSearch {
  param([string]$Keyword)
  $channels = Get-ChannelsHomeWindow
  [WeChatNativeInput]::ShowWindow($channels.Handle, 9) | Out-Null
  [WeChatNativeInput]::SetForegroundWindow($channels.Handle) | Out-Null

  $documentRect = $channels.Document.Current.BoundingRectangle
  if ($documentRect.Width -le 0 -or $documentRect.Height -le 0) {
    throw '无法定位视频号页面右上角的搜索入口。'
  }

  # 视频号页面的搜索入口固定在内容区域右上角；按内容区而不是整个微信窗口定位，兼容最大化和小窗口。
  $iconOffset = [Math]::Max(58, [Math]::Min(76, $documentRect.Width * 0.046))
  $topOffset = [Math]::Max(20, [Math]::Min(30, $documentRect.Height * 0.035))
  Click-Point ($documentRect.Right - $iconOffset) ($documentRect.Top + $topOffset)
  Start-Sleep -Milliseconds 220

  # 搜索框在放大镜左侧展开；该输入框由视频号页面绘制，当前微信版本不会稳定暴露为 UIA Edit。
  Click-Point ($documentRect.Right - 160) ($documentRect.Top + $topOffset)
  [System.Windows.Forms.Clipboard]::SetText($Keyword)
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 450

  $root = $Auto::FromHandle($channels.Handle)
  return [pscustomobject]@{ Process = $channels.Process; Root = $root; Handle = $channels.Handle }
}

function Wait-SearchResults {
  param($WindowRoot, [string]$Keyword)
  $deadline = [DateTime]::UtcNow.AddSeconds(18)
  do {
    $documents = Find-All $WindowRoot $ControlType::Document
    foreach ($document in $documents) {
      $name = [string]$document.Current.Name
      if ($name -like "*$Keyword*" -and $name -match '视频(?:号)?.*搜一搜|搜一搜.*视频(?:号)?') { return $document }
    }
    Start-Sleep -Milliseconds 350
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "搜索关键词「$Keyword」后未出现视频号结果。"
}

function Select-HottestSearchFilter {
  param($WindowRoot, $ResultsDocument)
  $deadline = [DateTime]::UtcNow.AddSeconds(6)
  do {
    $hotFilter = Find-One $WindowRoot $null '最热' ''
    if ($null -ne $hotFilter -and (Click-Element $hotFilter)) {
      Start-Sleep -Milliseconds 900
      return [pscustomobject]@{ Verified = $true; Method = 'uia_text' }
    }
    Start-Sleep -Milliseconds 250
    try { $WindowRoot = $Auto::FromHandle($WindowRoot.Current.NativeWindowHandle) } catch {}
  } while ([DateTime]::UtcNow -lt $deadline)

  # 某些微信版本只绘制筛选文字、不暴露 UIA 节点；使用结果文档内固定筛选行作为兜底。
  $documentRect = $ResultsDocument.Current.BoundingRectangle
  if ($documentRect.Width -le 0 -or $documentRect.Height -le 0) {
    throw '未找到视频搜索结果中的「最热」筛选。'
  }
  Click-Point ($documentRect.Left + $documentRect.Width * 0.414) ($documentRect.Top + 128)
  Start-Sleep -Milliseconds 1100
  return [pscustomobject]@{ Verified = $true; Method = 'result_relative_position' }
}

function Wait-DetailDocument {
  param($WindowRoot)
  $deadline = [DateTime]::UtcNow.AddSeconds(9)
  do {
    $documents = Find-All $WindowRoot $ControlType::Document
    foreach ($document in $documents) {
      if ($document.Current.Name -ne '视频号') { continue }
      $buttons = Find-All $document $ControlType::Button
      foreach ($button in $buttons) {
        if ($button.Current.Name -match '^(喜欢|推荐)，') { return $document }
      }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  return $null
}

function Parse-PublicNumber {
  param([string]$Value)
  if (-not $Value) { return $null }
  $text = $Value.Replace(',', '').Replace('，', '').Trim()
  if ($text -notmatch '([0-9]+(?:\.[0-9]+)?)\s*(亿|万|[wWkK])?') { return $null }
  $number = [double]$Matches[1]
  $unit = $Matches[2]
  if ($unit -eq '亿') { $number *= 100000000 }
  elseif ($unit -eq '万' -or $unit -match '[wW]') { $number *= 10000 }
  elseif ($unit -match '[kK]') { $number *= 1000 }
  return [int64][Math]::Round($number)
}

function Metric-FromButtons {
  param($Buttons, [string]$Label)
  foreach ($button in $Buttons) {
    $name = $button.Current.Name
    if ($name -match "^$Label，(.+)$") { return Parse-PublicNumber $Matches[1] }
  }
  return $null
}

function Read-FirstDetail {
  param($Document, [string]$Keyword, [int]$Rank, [bool]$SearchFilterVerified)
  $all = Find-All $Document $null
  $texts = [System.Collections.Generic.List[string]]::new()
  $buttons = [System.Collections.Generic.List[object]]::new()
  $author = $null
  $title = $null
  $productText = $null
  $lastText = $null
  foreach ($element in $all) {
    $type = $element.Current.ControlType
    $name = [string]$element.Current.Name
    if ($type -eq $ControlType::Text -and $name) {
      $texts.Add($name)
      if (-not $title -and $name.Length -ge 4 -and $name -notmatch '^(商品[:：]|展开|\d+个朋友关注)') { $title = $name }
      if ($name -match '^商品[:：]\s*(.+)$') { $productText = $Matches[1].Trim() }
      $lastText = $name
    }
    if ($type -eq $ControlType::Button) {
      $buttons.Add($element)
      if ($name -eq '+关注' -and -not $author -and $lastText) { $author = $lastText }
    }
  }
  if (-not $title) { return $null }
  $recommend = Metric-FromButtons $buttons '(?:喜欢|推荐)'
  $share = Metric-FromButtons $buttons '分享'
  $like = Metric-FromButtons $buttons '点赞'
  $comment = Metric-FromButtons $buttons '评论'
  if ($null -eq $recommend -and $null -eq $like -and $null -eq $share -and $null -eq $comment) { return $null }
  $nativeLabel = $texts | Where-Object { $_ -match '疑似\s*AI\s*生成|内容由\s*AI\s*生成' } | Select-Object -First 1
  $authorLabel = if ($nativeLabel) { $nativeLabel } else { [regex]::Match($title, '(?i)#?AI(?:生成|制作|创作|搞笑视频|视频|动画|数字人)?|AIGC|数字人').Value }
  $metricsComplete = $null -ne $recommend -and $null -ne $share -and $null -ne $like -and $null -ne $comment
  $identity = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$Keyword|$Rank|$title|$author")).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $encodedKeyword = [Uri]::EscapeDataString($Keyword)
  $sourceUrl = "http://127.0.0.1:4318/api/channels/open-search?keyword=$encodedKeyword&rank=$Rank&id=$identity"
  $evidence = [ordered]@{
    recommendCount = @{ value = $recommend; text = [string]$recommend; selector = '视频号详情页公开「喜欢/推荐」按钮'; verified = $null -ne $recommend }
    shareCount = @{ value = $share; text = [string]$share; selector = '视频号详情页公开「分享」按钮'; verified = $null -ne $share }
    likeCount = @{ value = $like; text = [string]$like; selector = '视频号详情页公开「点赞」按钮'; verified = $null -ne $like }
    commentCount = @{ value = $comment; text = [string]$comment; selector = '视频号详情页公开「评论」按钮'; verified = $null -ne $comment }
  }
  return [ordered]@{
    platform = 'channels'; platformItemId = $identity; sourceUrl = $sourceUrl
    title = $title; authorName = $author; publishedAt = $null; thumbnailUrl = $null; mediaUrl = $null
    viewCount = $null; favoriteCount = $null; recommendCount = $recommend
    shareCount = $share; likeCount = $like; commentCount = $comment
    productName = $productText; platformAiBadge = [bool]$nativeLabel; platformAiLabel = $authorLabel
    aiDeclared = [bool]$authorLabel; query = $Keyword
    rawText = ($texts -join ' ').Substring(0, [Math]::Min(($texts -join ' ').Length, 2000))
    rawMetrics = [ordered]@{
      sourceKind = 'wechat_public_search'; wechatSearchKeyword = $Keyword; publicSearchRank = $Rank
      searchFilterVerified = $SearchFilterVerified; metricsVerified = $metricsComplete; aiEvidenceVerified = [bool]$authorLabel
      aiEvidenceType = if ($nativeLabel) { 'platform_declaration' } elseif ($authorLabel) { 'author_disclosure' } else { $null }
      platformAiLabel = $authorLabel; metricScope = if ($metricsComplete) { 'public_detail_verified' } else { 'public_detail_partial' }
      metricEvidence = $evidence; searchFilter = @{ sort = 'hot'; sortLabel = '视频号·最热'; timeLabel = '公域搜索' }
      detailCollectedAt = [DateTime]::UtcNow.ToString('o')
    }
  }
}

$requestJson = [System.IO.File]::ReadAllText($RequestPath, [System.Text.UTF8Encoding]::new($false))
$request = $requestJson | ConvertFrom-Json
$keywords = @($request.keywords | ForEach-Object { [string]$_ })
$topN = if ([int]$request.topN -eq 15) { 15 } else { 20 }
$candidates = [System.Collections.Generic.List[object]]::new()
$searchCards = 0
$aiCandidates = 0

Write-ProgressEvent 'opening' 4 '正在连接已登录的微信电脑版'
$channels = Get-ChannelsHomeWindow
$handle = $channels.Handle
[WeChatNativeInput]::ShowWindow($handle, 9) | Out-Null
[WeChatNativeInput]::SetForegroundWindow($handle) | Out-Null
$rect = Get-WindowRectangle $handle
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

for ($keywordIndex = 0; $keywordIndex -lt $keywords.Count; $keywordIndex++) {
  $keyword = $keywords[$keywordIndex]
  $baseProgress = 8 + [Math]::Floor(($keywordIndex / [Math]::Max($keywords.Count, 1)) * 68)
  Write-ProgressEvent 'searching' $baseProgress "正在全网搜索视频号关键词「$keyword」" $searchCards $candidates.Count $aiCandidates
  $search = Open-ChannelsKeywordSearch $keyword
  $handle = $search.Handle
  $root = $search.Root
  $resultsDocument = Wait-SearchResults $root $keyword
  Write-ProgressEvent 'sorting' ($baseProgress + 2) "正在点击「最热」，等待「$keyword」热门结果刷新" $searchCards $candidates.Count $aiCandidates
  $hotFilter = Select-HottestSearchFilter $root $resultsDocument
  if ($request.openOnly) {
    $openResult = [ordered]@{ candidates = @(); searchCardCount = 0; openedKeyword = $keyword; hotFilterVerified = $hotFilter.Verified; hotFilterMethod = $hotFilter.Method }
    [System.IO.File]::WriteAllText($OutputPath, ($openResult | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
    Write-ProgressEvent 'completed' 100 "已在微信中打开「$keyword」的视频最热结果"
    exit 0
  }

  for ($rankIndex = 0; $rankIndex -lt $topN; $rankIndex++) {
    $column = $rankIndex % 3
    if ($rankIndex -gt 0 -and $column -eq 0) {
      [WeChatNativeInput]::SetForegroundWindow($handle) | Out-Null
      $scrollRect = Get-WindowRectangle $handle
      Scroll-SearchRow ($scrollRect.Left + ($scrollRect.Right - $scrollRect.Left) * 0.5) ($scrollRect.Top + ($scrollRect.Bottom - $scrollRect.Top) * 0.72)
      Start-Sleep -Milliseconds 650
    }
    $xRatios = @(0.24, 0.49, 0.74)
    $rect = Get-WindowRectangle $handle
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    Click-Point ($rect.Left + $width * $xRatios[$column]) ($rect.Top + $height * 0.61)
    Start-Sleep -Milliseconds 850
    $root = $Auto::FromHandle($handle)
    $detail = Wait-DetailDocument $root
    $searchCards += 1
    if ($null -ne $detail) {
      $candidate = Read-FirstDetail $detail $keyword ($rankIndex + 1) ([bool]$hotFilter.Verified)
      if ($null -ne $candidate) {
        $candidates.Add([pscustomobject]$candidate)
        if ($candidate.aiDeclared) { $aiCandidates += 1 }
      }
      Press-CtrlW
      Start-Sleep -Milliseconds 420
    } else {
      Press-Key 0x1B
      Start-Sleep -Milliseconds 250
    }
    $progress = [Math]::Min(80, $baseProgress + [Math]::Floor((($rankIndex + 1) / $topN) * (66 / [Math]::Max($keywords.Count, 1))))
    Write-ProgressEvent 'reading_details' $progress "「$keyword」已打开 $($rankIndex + 1)/$topN 条最热结果的详情页" $searchCards $candidates.Count $aiCandidates
  }
}

$result = [ordered]@{ candidates = $candidates; searchCardCount = $searchCards; collectedAt = [DateTime]::UtcNow.ToString('o') }
$json = $result | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($OutputPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-ProgressEvent 'processing' 82 "已读取 $($candidates.Count) 条公域详情，正在进行AI证据和产品相关性筛选" $searchCards $candidates.Count $aiCandidates
