"""Training-only PyTorch architecture; runtime consumes ONNX exports."""
import torch
from torch import nn
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights


class VisualEncoder(nn.Module):
    def __init__(self, pretrained=True):
        super().__init__()
        self.features=mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT if pretrained else None).features
        self.pool=nn.AdaptiveAvgPool2d(1)
        self.projection=nn.Sequential(nn.Linear(576,128),nn.LayerNorm(128),nn.ReLU())
    def forward(self,x):
        return self.projection(self.pool(self.features(x)).flatten(1))


class TemporalBlock(nn.Module):
    def __init__(self,dilation):
        super().__init__()
        self.network=nn.Sequential(nn.Conv1d(64,64,3,padding=dilation,dilation=dilation),nn.BatchNorm1d(64),nn.ReLU(),nn.Dropout(.15))
    def forward(self,x):return x+self.network(x)


class RearingTCN(nn.Module):
    def __init__(self,feature_dim):
        super().__init__()
        self.input_projection=nn.Conv1d(feature_dim,64,1)
        self.temporal_blocks=nn.Sequential(*(TemporalBlock(d) for d in [1,2,4,8]))
        self.head=nn.Conv1d(64,2,1)
    def forward(self,x):
        x=self.head(self.temporal_blocks(self.input_projection(x)))
        return x[:,:,x.shape[2]//2]


class ProbabilityHead(nn.Module):
    def __init__(self,model,subtype_trained):
        super().__init__();self.model=model;self.subtype_trained=subtype_trained
    def forward(self,x):
        scores=torch.sigmoid(self.model(x))
        return scores if self.subtype_trained else torch.stack((scores[:,0],torch.ones_like(scores[:,1])*.5),1)
