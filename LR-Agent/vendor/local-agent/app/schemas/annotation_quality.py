# 学习导航：质量报告接口的请求结构；compose_payload 是调用方已经准备好的指标、发现和图表路径。
from pydantic import BaseModel, Field

from app.schemas.annotation_agent import AnnotationLlmBaseRequest


# 包含模型连接配置和报告数据，服务据此撰写文字，不在此计算质量指标。
class QualityReportComposeRequest(AnnotationLlmBaseRequest):
    compose_payload: dict = Field(default_factory=dict)
