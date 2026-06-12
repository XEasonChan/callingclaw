---
type: "note"
---
### AI

**Agent 能力修复**

* [x] 对比 openAI agent SDK, claude sdk, openclaw CLI 嵌入，自研和Claude code CLI接入 - 最后选择参考openai sdk的思想，我们优化自研的
* [x] 多轮自动调用，不同工具是否已经原子化可以调用
* [x] sideband逻辑的通信实现 - pending
* [ ] 现在agent开会过程中有什么任务是会给到复杂模型去做的，像是需要给到openclaw和Claude code在会议中并行去做的
* [x] 新增一个prompt调试后台

⠀

### 前端：会议主题homepage

* [x] 嵌入可交互的滚动iframe

  * [x] 需要验证当前playwright是否可以在iframe里面点击和解析
  * [x] 框架的边上可以加上类似于 Siri 那样的渐变描边，来让用户感觉这是 Agent 在点击和演示

* [x] 右下角默认相关文件列表。带编号暴露给AI，可以快速检索和新增

* [x] 在显示当前会议 Agent 和后端 OpenCall 或者 CrossCall 的 Event Bus，让用户感觉他同时在会议里面，两个 Agent 都在敏捷地收取信号，进行执行和对话

⠀

### 测试：语音模型Eval

* [ ] 当前已经接入了openai realtime 1.5， Gemini 和Grok 4，都是最近两周业内最新进展的模型，需要知道他们的边界以及怎么组合
* [ ] 记忆prompt框架，现在的prompt是怎么样的，然后模型之间通信的协议是否已经约定好了
* [x] 研究一下现在业内主流的voice agent都是怎么做语音效果和浏览器agent效果执行的eval的,我们也参考着设计一个.主要看huggingface和github的benchmark
* [x] 我跟他说那个文件的时候他不知道，还反过来问我，应该在本地模型的记忆或者tool里面是可以拿到的，我们已经做了这个agentic的流程了
*

⠀

### 后端

**Presentation Engine**

* [ ] 非定时的presentation engine加上我们的meeting stage要怎么做比较好？
* [x] 加入会议的时候没有选择声音，会选中虚拟驱动
* [ ] 参会前的provider不受控，选择了openai但是Gemini加入，还有WebSocket连接失败
* [ ] 当前Gemini的新API key是否可以正常使用
* [ ] 会后没有自动生成符合和我们的skill一致的meeting summary html
* [ ] 投屏失败，没办法打开对应的本地文件，这个是最基本的，之前我们已经可以很稳定实现了，这一段代码是哪里修改了，可以看看

⠀

**投屏能力**

* [x] 昨晚远程开启投屏失败

⠀

### 宣传推广

* [ ] 官网设计故事框架
* [ ] 官网设计优化
* [ ] 相关图片素材 - 2张 【X，小红书，Github】
* [ ] demo 视频

⠀

### 全链路验收

* [ ] 自己总是会掉Google calendar的绑定
* [ ] 语音意图识别的测试集

⠀