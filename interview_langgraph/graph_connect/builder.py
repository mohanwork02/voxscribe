from langgraph.constants import END, START
from langgraph.graph.state import StateGraph

from interview_langgraph.edges.route_edges import (
    ANSWER_TO_NODE,
    ROUTE_TO_NODE,
    START_TO_NODE,
    answer_path,
    route_path,
    start_path,
)
from interview_langgraph.nodes.code import answer_code
from interview_langgraph.nodes.ingest import ingest_documents
from interview_langgraph.nodes.introduction import answer_with_introduction
from interview_langgraph.nodes.project_explaination import explain_projects
from interview_langgraph.nodes.qa import answer_qa
from interview_langgraph.nodes.scenario import answer_scenario
from interview_langgraph.nodes.start import start_node
from interview_langgraph.route.router import route_node
from interview_langgraph.state import WorkflowState


def build_graph():
    graph = StateGraph(WorkflowState)
    graph.add_node("start", start_node)
    graph.add_node("ingest", ingest_documents)
    graph.add_node("route", route_node)
    graph.add_node("introduction", answer_with_introduction)
    graph.add_node("project_explaination", explain_projects)
    graph.add_node("code", answer_code)
    graph.add_node("scenario", answer_scenario)
    graph.add_node("qa", answer_qa)

    graph.add_edge(START, "start")
    graph.add_conditional_edges("start", start_path, START_TO_NODE)
    graph.add_edge("ingest", "route")
    graph.add_conditional_edges("route", route_path, ROUTE_TO_NODE)
    graph.add_conditional_edges("introduction", answer_path, ANSWER_TO_NODE)
    graph.add_conditional_edges("project_explaination", answer_path, ANSWER_TO_NODE)
    graph.add_conditional_edges("code", answer_path, ANSWER_TO_NODE)
    graph.add_conditional_edges("scenario", answer_path, ANSWER_TO_NODE)
    graph.add_edge("qa", END)
    return graph.compile()
