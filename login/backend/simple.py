import streamlit as st
import stt_loopback 

st.set_page_config(page_title="Live Transcript", layout="wide")
st.title("Live Transcript Demo")

if "all_text" not in st.session_state:
    st.session_state.all_text = ""

if "box_counter" not in st.session_state:
    st.session_state.box_counter = 0

col1, col2 = st.columns(2)

with col1:
    start = st.button("Start")

with col2:
    clear = st.button("Clear")

if clear:
    st.session_state.all_text = ""

placeholder = st.empty()

def render_transcript():
    st.session_state.box_counter += 1
    placeholder.text_area(
        "Transcript",
        value=st.session_state.all_text,
        height=300,
        disabled=True,
        key=f"transcript_box_{st.session_state.box_counter}"
    )

# initial render
render_transcript()

if start:
    st.session_state.all_text = ""
    render_transcript()

    st.write("Listening to system audio...")

    for transcript in stt_loopback.stream_transcripts():
        st.session_state.all_text += transcript + "\n"
        render_transcript()