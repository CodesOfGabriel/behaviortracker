"""Export only trained checkpoints; verify parity before publishing an ONNX bundle."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import numpy as np
from common import ROOT, write_json
from behavior.contracts import FEATURES, SCHEMA, DECODER


def forest_graph(models, destination):
    import onnx
    from onnx import helper, TensorProto
    # Export each probability head as a forest of leaf probabilities. Explicit integer
    # attributes avoid converter/protobuf boolean-list compatibility differences.
    nodes=[]
    initializers=[]
    for name,model in models.items():
        if model is None:continue
        attrs={key:[] for key in ['nodes_treeids','nodes_nodeids','nodes_featureids','nodes_modes','nodes_values',
            'nodes_truenodeids','nodes_falsenodeids','nodes_missing_value_tracks_true',
            'target_treeids','target_nodeids','target_ids','target_weights']}
        for tree_id,estimator in enumerate(model.estimators_):
            tree=estimator.tree_
            for node_id in range(tree.node_count):
                leaf=tree.children_left[node_id]==tree.children_right[node_id]
                threshold=float(tree.threshold[node_id])
                boundary=np.float32(threshold)
                if boundary>threshold:boundary=np.nextafter(boundary,np.float32(-np.inf))
                values={'nodes_treeids':tree_id,'nodes_nodeids':node_id,'nodes_featureids':0 if leaf else int(tree.feature[node_id]),
                    'nodes_modes':'LEAF' if leaf else 'BRANCH_LEQ','nodes_values':0. if leaf else float(boundary),
                    'nodes_truenodeids':0 if leaf else int(tree.children_left[node_id]),
                    'nodes_falsenodeids':0 if leaf else int(tree.children_right[node_id]),
                    'nodes_missing_value_tracks_true':int(tree.missing_go_to_left[node_id]) if hasattr(tree,'missing_go_to_left') else 0}
                for key,value in values.items():attrs[key].append(value)
                if leaf:
                    distribution=tree.value[node_id,0]
                    positive=float(distribution[1]/distribution.sum())
                    for key,value in {'target_treeids':tree_id,'target_nodeids':node_id,'target_ids':0,'target_weights':positive/len(model.estimators_)}.items():attrs[key].append(value)
        nodes.append(helper.make_node('TreeEnsembleRegressor',['features'],[name+'_positive'],domain='ai.onnx.ml',
            n_targets=1,aggregate_function='SUM',post_transform='NONE',**attrs))
    if models['subtype'] is None:
        initializers.append(helper.make_tensor('half',TensorProto.FLOAT,[1],[.5]))
        initializers.append(helper.make_tensor('zero',TensorProto.FLOAT,[1],[0.]))
        nodes.append(helper.make_node('Mul',['rearing_positive','zero'],['sub_zero']))
        nodes.append(helper.make_node('Add',['sub_zero','half'],['subtype_positive']))
    nodes.append(helper.make_node('Concat',['rearing_positive','subtype_positive'],['scores'],axis=1))
    inputs=[helper.make_tensor_value_info('features',TensorProto.FLOAT,[None,2*len(FEATURES)])]
    graph=helper.make_graph(nodes,'OFT_Rearing_RF',inputs,[helper.make_tensor_value_info('scores',TensorProto.FLOAT,[None,2])],initializer=initializers)
    model=helper.make_model(graph,opset_imports=[helper.make_opsetid('',17),helper.make_opsetid('ai.onnx.ml',3)],ir_version=9)
    onnx.checker.check_model(model);onnx.save(model,str(destination))


def export(checkpoint, output, version, release_base=None):
    import onnxruntime as ort
    checkpoint,output=Path(checkpoint),Path(output)
    info=json.loads((checkpoint/'training.json').read_text())
    output.mkdir(parents=True,exist_ok=False)
    rng=np.random.default_rng(42)
    if info['architecture']=='random_forest':
        # Only use checkpoints produced by this project's training script.
        import joblib
        models=joblib.load(checkpoint/'baseline.joblib')
        forest_graph(models,output/'temporal_classifier.onnx')
        x=rng.normal(size=(8,2*len(FEATURES))).astype(np.float32)
        expected=np.column_stack((models['rearing'].predict_proba(x)[:,1],models['subtype'].predict_proba(x)[:,1] if models['subtype'] else np.full(len(x),.5)))
    else:
        import torch
        from torch import nn
        from networks import VisualEncoder, RearingTCN, ProbabilityHead
        encoder=VisualEncoder(pretrained=False)
        encoder.load_state_dict(torch.load(checkpoint/'encoder.pt',weights_only=True,map_location='cpu'));encoder.eval()
        image=rng.normal(size=(3,3,128,128)).astype(np.float32)
        torch.onnx.export(encoder,torch.tensor(image),str(output/'visual_encoder.onnx'),input_names=['rgb'],output_names=['embedding'],dynamic_axes={'rgb':{0:'batch'},'embedding':{0:'batch'}},opset_version=17,dynamo=False)
        session=ort.InferenceSession(str(output/'visual_encoder.onnx'),providers=['CPUExecutionProvider'])
        with torch.no_grad():expected_embedding=encoder(torch.tensor(image)).numpy()
        np.testing.assert_allclose(session.run(None,{'rgb':image})[0],expected_embedding,atol=1e-4,rtol=1e-4)
        classifier=nn.Linear(128,2) if info['architecture']=='visual' else RearingTCN(info['featureDim'])
        classifier.load_state_dict(torch.load(checkpoint/'classifier.pt',weights_only=True,map_location='cpu'));classifier.eval()
        classifier=ProbabilityHead(classifier,info['subtypeTrained']).eval()
        x=rng.normal(size=(8,128) if info['architecture']=='visual' else (8,info['featureDim'],31)).astype(np.float32)
        with torch.no_grad():expected=classifier(torch.tensor(x)).numpy()
        torch.onnx.export(classifier,torch.tensor(x),str(output/'temporal_classifier.onnx'),input_names=['features'],output_names=['scores'],dynamic_axes={'features':{0:'batch'},'scores':{0:'batch'}},opset_version=17,dynamo=False)
    session=ort.InferenceSession(str(output/'temporal_classifier.onnx'),providers=['CPUExecutionProvider'])
    actual=session.run(None,{'features':x})[0]
    np.testing.assert_allclose(actual,expected,atol=1e-4,rtol=1e-4)
    shutil.copy(checkpoint/'normalization.json',output/'normalization.json')
    write_json(output/'feature_schema.json',dict(schemaVersion=SCHEMA,features=list(FEATURES),units='original_video_pixels_and_seconds',missing='zero_with_validity_mask'))
    write_json(output/'decoder_config.json',DECODER)
    code=hashlib.sha256()
    for path in sorted((ROOT/'scripts/behavior').glob('*.py'))+sorted((ROOT/'src-tauri/python/behavior').glob('*.py')):code.update(path.name.encode()+path.read_bytes())
    files={}
    for path in sorted(output.iterdir()):
        spec=dict(sizeBytes=path.stat().st_size,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        if release_base:spec['url']=release_base.rstrip('/')+'/'+path.name
        files[path.name]=spec
    manifest=json.loads((ROOT/'models/oft_rearing_v1/manifest.json').read_text())
    manifest.update(modelVersion=version,architecture=info['architecture'],availability='trained',files=files,
        sampleRateHz=info['sampleRateHz'],subtypeTrained=info['subtypeTrained'],trainingCodeSha256=code.hexdigest(),
        training=info,probabilityCalibrated=False,validationResults=None,
        numericalParity=dict(atol=1e-4,rtol=1e-4,maximumAbsoluteError=float(np.max(np.abs(actual-expected)))),
        decoderStatus='development_defaults_not_optimized',validationStatus='experimental')
    if release_base:
        if not release_base.startswith('https://') or '/releases/download/' not in release_base or release_base.endswith('/latest'):
            raise ValueError('A pinned HTTPS release base URL is required')
        manifest['releaseTag']=release_base.rstrip('/').rsplit('/',1)[-1]
    write_json(output/'manifest.json',manifest)
    from behavior.model_registry import load_manifest
    load_manifest(output/'manifest.json')
    print(json.dumps(manifest['numericalParity']))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('checkpoint');p.add_argument('output');p.add_argument('--version',required=True);p.add_argument('--release-base');a=p.parse_args();export(a.checkpoint,a.output,a.version,a.release_base)
